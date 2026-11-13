// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {TicketNFT} from "./TicketNFT.sol";

/**
 * @title EventTicketing
 * @author EntradaSegura
 * @notice Venta primaria, reventa con tope de precio y control de acceso (check-in) de entradas
 *         para eventos masivos. Cada entrada es un NFT unico y verificable on-chain, lo que
 *         elimina la falsificacion de entradas fisicas.
 * @dev Flujo principal:
 *      1. Un organizador crea un evento (`createEvent`).
 *      2. Los compradores pagan en stablecoin (`buyTickets`) y reciben NFTs.
 *      3. En el ingreso, el titular firma off-chain un mensaje de corta duracion (QR rotativo)
 *         y un validador lo registra on-chain (`checkIn`). Cada entrada se puede usar una sola vez.
 *
 *      Roles (OpenZeppelin AccessControl):
 *      - `DEFAULT_ADMIN_ROLE`: otorga/revoca roles y puede cancelar cualquier evento.
 *      - `ORGANIZER_ROLE`: puede crear eventos; solo el organizador de un evento puede retirar sus fondos.
 *      - `VALIDATOR_ROLE`: personal de acceso autorizado a ejecutar `checkIn`.
 *
 *      Limitaciones conocidas del MVP: un unico `VALIDATOR_ROLE` global, no hay soporte ERC-1271
 *      (billeteras de contrato) para firmar el check-in, y el fee de reventa es fijo.
 */
contract EventTicketing is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 TIPOS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Datos de un evento (empaquetados en 2 slots).
     * @param organizer Cuenta organizadora (0 = evento inexistente).
     * @param startTime Inicio del evento (timestamp). Las ventas cierran en este momento.
     * @param sold Cantidad de entradas vendidas.
     * @param price Precio de cara por entrada, en unidades minimas del token de pago.
     * @param endTime Fin del evento (timestamp).
     * @param capacity Capacidad maxima de entradas.
     * @param maxPerWallet Maximo de entradas por billetera en venta primaria (anti-acaparamiento).
     * @param cancelled Si el evento fue cancelado (habilita reembolsos).
     */
    struct EventData {
        address organizer;
        uint64 startTime;
        uint32 sold;
        uint128 price;
        uint64 endTime;
        uint32 capacity;
        uint16 maxPerWallet;
        bool cancelled;
    }

    /**
     * @notice Datos asociados a cada entrada.
     * @param eventId Evento al que pertenece.
     * @param used Si ya fue utilizada en el ingreso.
     */
    struct TicketData {
        uint32 eventId;
        bool used;
    }

    /**
     * @notice Publicacion de una entrada en reventa.
     * @param seller Vendedor (0 = sin publicacion).
     * @param price Precio pedido, en unidades minimas del token de pago.
     */
    struct Listing {
        address seller;
        uint128 price;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTANTES
    //////////////////////////////////////////////////////////////*/

    /// @notice Rol de organizadores de eventos.
    bytes32 public constant ORGANIZER_ROLE = keccak256("ORGANIZER_ROLE");

    /// @notice Rol del personal de acceso que valida entradas en el ingreso.
    bytes32 public constant VALIDATOR_ROLE = keccak256("VALIDATOR_ROLE");

    /// @notice Denominador de basis points (100% = 10.000).
    uint256 public constant BPS = 10_000;

    /// @notice Sobreprecio maximo permitido en reventa sobre el precio de cara (10%).
    uint256 public constant MAX_RESALE_MARKUP_BPS = 1_000;

    /// @notice Comision que recibe el organizador en cada reventa (5% del precio de reventa).
    uint256 public constant RESALE_FEE_BPS = 500;

    /// @notice Antelacion maxima con la que se habilita el check-in antes del inicio (4 horas).
    uint64 public constant CHECKIN_OPENS_BEFORE = 4 hours;

    /// @notice Plazo posterior al fin de un evento cancelado para reclamar reembolsos (30 dias).
    uint64 public constant REFUND_WINDOW = 30 days;

    /*//////////////////////////////////////////////////////////////
                                ESTADO
    //////////////////////////////////////////////////////////////*/

    /// @notice Token ERC-20 usado para todos los pagos (stablecoin).
    IERC20 public immutable paymentToken;

    /// @notice Coleccion de entradas NFT, desplegada por este contrato.
    TicketNFT public immutable ticketNFT;

    /// @notice Cantidad de eventos creados; el ultimo id existente es igual a este valor.
    uint32 public eventCount;

    /// @notice Datos de cada evento por id.
    mapping(uint32 eventId => EventData data) public events;

    /// @notice Fondos acumulados (ventas + comisiones de reventa) por evento, pendientes de retiro.
    mapping(uint32 eventId => uint256 amount) public proceeds;

    /// @notice Entradas compradas por billetera en venta primaria, por evento.
    mapping(uint32 eventId => mapping(address buyer => uint16 amount)) public purchased;

    /// @notice Datos de cada entrada por tokenId.
    mapping(uint256 tokenId => TicketData data) public ticketData;

    /// @notice Publicaciones de reventa activas por tokenId (la entrada queda en custodia del contrato).
    mapping(uint256 tokenId => Listing listing) public listings;

    /*//////////////////////////////////////////////////////////////
                                EVENTOS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Se creo un evento.
     * @param eventId Id del evento.
     * @param organizer Organizador.
     * @param name Nombre del evento (solo se emite, no se guarda, para ahorrar gas).
     * @param startTime Inicio.
     * @param endTime Fin.
     * @param price Precio de cara por entrada.
     * @param capacity Capacidad maxima.
     * @param maxPerWallet Limite por billetera.
     */
    event EventCreated(
        uint32 indexed eventId,
        address indexed organizer,
        string name,
        uint64 startTime,
        uint64 endTime,
        uint128 price,
        uint32 capacity,
        uint16 maxPerWallet
    );

    /**
     * @notice Se compraron entradas en venta primaria.
     * @param eventId Evento.
     * @param buyer Comprador.
     * @param firstTokenId Primer tokenId emitido en la compra (los siguientes son consecutivos).
     * @param quantity Cantidad comprada.
     * @param totalPaid Total pagado.
     */
    event TicketsPurchased(
        uint32 indexed eventId, address indexed buyer, uint256 firstTokenId, uint16 quantity, uint256 totalPaid
    );

    /**
     * @notice Una entrada fue publicada en reventa.
     * @param tokenId Entrada.
     * @param seller Vendedor.
     * @param price Precio pedido.
     */
    event TicketListed(uint256 indexed tokenId, address indexed seller, uint128 price);

    /**
     * @notice Una publicacion de reventa fue cancelada.
     * @param tokenId Entrada.
     * @param seller Vendedor.
     */
    event ListingCancelled(uint256 indexed tokenId, address indexed seller);

    /**
     * @notice Una entrada se vendio en reventa.
     * @param tokenId Entrada.
     * @param seller Vendedor.
     * @param buyer Comprador.
     * @param price Precio pagado.
     * @param organizerFee Comision acreditada al organizador.
     */
    event TicketResold(
        uint256 indexed tokenId, address indexed seller, address indexed buyer, uint128 price, uint256 organizerFee
    );

    /**
     * @notice Una entrada fue regalada/transferida sin costo.
     * @param tokenId Entrada.
     * @param from Cuenta emisora.
     * @param to Cuenta receptora.
     */
    event TicketTransferred(uint256 indexed tokenId, address indexed from, address indexed to);

    /**
     * @notice Una entrada fue validada en el ingreso.
     * @param tokenId Entrada.
     * @param eventId Evento.
     * @param holder Titular que firmo el pase.
     * @param validator Validador que ejecuto el check-in.
     */
    event TicketCheckedIn(
        uint256 indexed tokenId, uint32 indexed eventId, address indexed holder, address validator
    );

    /**
     * @notice Un evento fue cancelado.
     * @param eventId Evento.
     * @param by Cuenta que lo cancelo.
     */
    event EventCancelled(uint32 indexed eventId, address indexed by);

    /**
     * @notice Se reembolso una entrada de un evento cancelado.
     * @param tokenId Entrada quemada.
     * @param holder Cuenta reembolsada.
     * @param amount Monto devuelto.
     */
    event TicketRefunded(uint256 indexed tokenId, address indexed holder, uint256 amount);

    /**
     * @notice El organizador retiro fondos de un evento.
     * @param eventId Evento.
     * @param organizer Organizador.
     * @param amount Monto retirado.
     */
    event ProceedsWithdrawn(uint32 indexed eventId, address indexed organizer, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                ERRORES
    //////////////////////////////////////////////////////////////*/

    /// @notice Direccion cero no permitida.
    error ZeroAddress();

    /// @notice Parametros de evento invalidos (fechas, precio, capacidad o limite en cero).
    error InvalidEventParams();

    /// @notice El evento no existe.
    /// @param eventId Id consultado.
    error EventNotFound(uint32 eventId);

    /// @notice El evento fue cancelado.
    /// @param eventId Evento.
    error EventIsCancelled(uint32 eventId);

    /// @notice El evento no fue cancelado (operacion solo valida para eventos cancelados).
    /// @param eventId Evento.
    error EventNotCancelled(uint32 eventId);

    /// @notice La operacion ya no esta disponible porque el evento comenzo o finalizo.
    /// @param eventId Evento.
    error EventClosed(uint32 eventId);

    /// @notice Cantidad invalida (cero).
    error InvalidQuantity();

    /// @notice No hay entradas suficientes.
    /// @param requested Cantidad pedida.
    /// @param available Cantidad disponible.
    error SoldOut(uint32 requested, uint32 available);

    /// @notice Se supero el limite por billetera.
    /// @param limit Limite permitido.
    error WalletLimitExceeded(uint16 limit);

    /// @notice La cuenta no es propietaria de la entrada.
    /// @param tokenId Entrada.
    error NotTicketOwner(uint256 tokenId);

    /// @notice La cuenta no esta autorizada para la operacion.
    error Unauthorized();

    /// @notice La entrada ya fue utilizada.
    /// @param tokenId Entrada.
    error TicketAlreadyUsed(uint256 tokenId);

    /// @notice Precio de reventa invalido (cero o superior al tope).
    /// @param price Precio pedido.
    /// @param maxPrice Tope permitido.
    error ResalePriceTooHigh(uint128 price, uint128 maxPrice);

    /// @notice La entrada no esta publicada en reventa.
    /// @param tokenId Entrada.
    error NotListed(uint256 tokenId);

    /// @notice La entrada ya esta publicada en reventa.
    /// @param tokenId Entrada.
    error AlreadyListed(uint256 tokenId);

    /// @notice El vendedor no puede comprar su propia publicacion.
    error SelfPurchase();

    /// @notice El check-in aun no esta habilitado o el evento ya termino.
    /// @param eventId Evento.
    error CheckInWindowClosed(uint32 eventId);

    /// @notice El pase firmado expiro.
    /// @param deadline Limite del pase.
    error PassExpired(uint256 deadline);

    /// @notice La firma no corresponde al titular actual de la entrada.
    /// @param tokenId Entrada.
    error InvalidSignature(uint256 tokenId);

    /// @notice Invariante interna violada: los ids emitidos no coinciden con los registrados.
    error TokenIdMismatch();

    /// @notice No hay fondos para retirar.
    error NothingToWithdraw();

    /// @notice Aun no se puede retirar (el evento no finalizo o sigue vigente el plazo de reembolsos).
    /// @param eventId Evento.
    error WithdrawNotAvailable(uint32 eventId);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @param paymentToken_ Stablecoin ERC-20 aceptada para pagos.
     * @param admin Cuenta que recibe `DEFAULT_ADMIN_ROLE`.
     */
    constructor(IERC20 paymentToken_, address admin) {
        if (address(paymentToken_) == address(0) || admin == address(0)) revert ZeroAddress();
        paymentToken = paymentToken_;
        ticketNFT = new TicketNFT("EntradaSegura Ticket", "ESTK", address(this));
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /*//////////////////////////////////////////////////////////////
                            GESTION DE EVENTOS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Crea un evento. Solo organizadores autorizados.
     * @param name Nombre del evento (se emite en el log, no se almacena).
     * @param startTime Inicio (debe ser futuro). Las ventas cierran en este instante.
     * @param endTime Fin (posterior al inicio).
     * @param price Precio de cara por entrada (> 0), en unidades minimas del token de pago.
     * @param capacity Capacidad total (> 0).
     * @param maxPerWallet Maximo de entradas por billetera en venta primaria (> 0).
     * @return eventId Id del evento creado.
     */
    function createEvent(
        string calldata name,
        uint64 startTime,
        uint64 endTime,
        uint128 price,
        uint32 capacity,
        uint16 maxPerWallet
    ) external onlyRole(ORGANIZER_ROLE) returns (uint32 eventId) {
        if (
            startTime <= block.timestamp || endTime <= startTime || price == 0 || capacity == 0
                || maxPerWallet == 0
        ) revert InvalidEventParams();

        eventId = ++eventCount;
        events[eventId] = EventData({
            organizer: msg.sender,
            startTime: startTime,
            sold: 0,
            price: price,
            endTime: endTime,
            capacity: capacity,
            maxPerWallet: maxPerWallet,
            cancelled: false
        });

        emit EventCreated(eventId, msg.sender, name, startTime, endTime, price, capacity, maxPerWallet);
    }

    /**
     * @notice Cancela un evento que aun no finalizo. Habilita reembolsos.
     * @dev Solo el organizador del evento o el admin.
     * @param eventId Evento a cancelar.
     */
    function cancelEvent(uint32 eventId) external {
        EventData storage ev = _getEvent(eventId);
        if (msg.sender != ev.organizer && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert Unauthorized();
        if (ev.cancelled) revert EventIsCancelled(eventId);
        if (block.timestamp >= ev.endTime) revert EventClosed(eventId);

        ev.cancelled = true;
        emit EventCancelled(eventId, msg.sender);
    }

    /**
     * @notice El organizador retira los fondos acumulados del evento.
     * @dev Disponible tras `endTime`. Si el evento fue cancelado, recien tras `endTime + REFUND_WINDOW`
     *      para garantizar que los compradores puedan reclamar su reembolso.
     * @param eventId Evento.
     */
    function withdrawProceeds(uint32 eventId) external nonReentrant {
        EventData storage ev = _getEvent(eventId);
        if (msg.sender != ev.organizer) revert Unauthorized();

        uint64 availableAt = ev.cancelled ? ev.endTime + REFUND_WINDOW : ev.endTime;
        if (block.timestamp <= availableAt) revert WithdrawNotAvailable(eventId);

        uint256 amount = proceeds[eventId];
        if (amount == 0) revert NothingToWithdraw();

        proceeds[eventId] = 0; // effects
        paymentToken.safeTransfer(msg.sender, amount); // interaction
        emit ProceedsWithdrawn(eventId, msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                              VENTA PRIMARIA
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Compra entradas de un evento pagando en el token de pago. Requiere `approve` previo.
     * @param eventId Evento.
     * @param quantity Cantidad de entradas (> 0).
     * @return firstTokenId Primer tokenId emitido (los demas son consecutivos).
     */
    function buyTickets(uint32 eventId, uint16 quantity) external nonReentrant returns (uint256 firstTokenId) {
        if (quantity == 0) revert InvalidQuantity();
        EventData storage ev = _getEvent(eventId);
        if (ev.cancelled) revert EventIsCancelled(eventId);
        if (block.timestamp >= ev.startTime) revert EventClosed(eventId);

        uint32 sold = ev.sold;
        uint32 available = ev.capacity - sold;
        if (quantity > available) revert SoldOut(quantity, available);

        uint16 newPurchased = purchased[eventId][msg.sender] + quantity;
        if (newPurchased > ev.maxPerWallet) revert WalletLimitExceeded(ev.maxPerWallet);

        uint256 total = uint256(ev.price) * quantity;

        // Effects
        ev.sold = sold + quantity;
        purchased[eventId][msg.sender] = newPurchased;
        proceeds[eventId] += total;

        // Los ids son consecutivos y conocidos de antemano: se registran antes de cualquier llamada externa.
        firstTokenId = ticketNFT.nextTokenId();
        for (uint16 i; i < quantity;) {
            ticketData[firstTokenId + i] = TicketData({eventId: eventId, used: false});
            unchecked {
                ++i; // seguro: i < quantity <= type(uint16).max
            }
        }

        // Interactions
        paymentToken.safeTransferFrom(msg.sender, address(this), total);
        if (ticketNFT.mintBatch(msg.sender, quantity) != firstTokenId) revert TokenIdMismatch();

        emit TicketsPurchased(eventId, msg.sender, firstTokenId, quantity, total);
    }

    /*//////////////////////////////////////////////////////////////
                         TRANSFERENCIA Y REVENTA
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Regala/transfiere una entrada sin costo a otra cuenta.
     * @param tokenId Entrada.
     * @param to Destinatario.
     */
    function transferTicket(uint256 tokenId, address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        TicketData storage t = ticketData[tokenId];
        _requireTransferable(tokenId, t);

        emit TicketTransferred(tokenId, msg.sender, to);
        ticketNFT.ticketTransfer(msg.sender, to, tokenId);
    }

    /**
     * @notice Publica una entrada en reventa. La entrada queda en custodia del contrato.
     * @dev El precio no puede superar `maxResalePrice` (precio de cara + 10%).
     * @param tokenId Entrada.
     * @param price Precio pedido (> 0).
     */
    function listForResale(uint256 tokenId, uint128 price) external nonReentrant {
        TicketData storage t = ticketData[tokenId];
        _requireTransferable(tokenId, t);

        uint128 maxPrice = maxResalePrice(t.eventId);
        if (price == 0 || price > maxPrice) revert ResalePriceTooHigh(price, maxPrice);

        listings[tokenId] = Listing({seller: msg.sender, price: price});
        emit TicketListed(tokenId, msg.sender, price);

        ticketNFT.ticketTransfer(msg.sender, address(this), tokenId);
    }

    /**
     * @notice Cancela una publicacion y devuelve la entrada al vendedor.
     * @param tokenId Entrada publicada.
     */
    function cancelListing(uint256 tokenId) external nonReentrant {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) revert NotListed(tokenId);
        if (l.seller != msg.sender) revert Unauthorized();

        delete listings[tokenId];
        emit ListingCancelled(tokenId, msg.sender);

        ticketNFT.ticketTransfer(address(this), msg.sender, tokenId);
    }

    /**
     * @notice Compra una entrada publicada en reventa. Requiere `approve` previo.
     * @dev El comprador paga `price`; el vendedor recibe `price - fee` y el organizador acumula `fee`.
     * @param tokenId Entrada publicada.
     */
    function buyResale(uint256 tokenId) external nonReentrant {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) revert NotListed(tokenId);
        if (l.seller == msg.sender) revert SelfPurchase();

        uint32 eventId = ticketData[tokenId].eventId;
        EventData storage ev = events[eventId];
        if (ev.cancelled) revert EventIsCancelled(eventId);
        if (block.timestamp >= ev.endTime) revert EventClosed(eventId);

        uint256 fee = (uint256(l.price) * RESALE_FEE_BPS) / BPS;

        // Effects
        delete listings[tokenId];
        proceeds[eventId] += fee;

        // Interactions
        paymentToken.safeTransferFrom(msg.sender, l.seller, l.price - fee);
        paymentToken.safeTransferFrom(msg.sender, address(this), fee);
        ticketNFT.ticketTransfer(address(this), msg.sender, tokenId);

        emit TicketResold(tokenId, l.seller, msg.sender, l.price, fee);
    }

    /*//////////////////////////////////////////////////////////////
                           CONTROL DE ACCESO
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Registra el ingreso de una entrada. Solo validadores.
     * @dev El titular firma off-chain (EIP-191) el digest de `getCheckInDigest(tokenId, deadline)`.
     *      Como el digest incluye contrato, chainId, tokenId y un `deadline` corto, una captura
     *      del QR deja de servir al expirar y la entrada solo puede usarse una vez.
     * @param tokenId Entrada a validar.
     * @param deadline Timestamp limite del pase firmado.
     * @param signature Firma del titular actual sobre el digest.
     */
    function checkIn(uint256 tokenId, uint256 deadline, bytes calldata signature)
        external
        onlyRole(VALIDATOR_ROLE)
    {
        TicketData storage t = ticketData[tokenId];
        uint32 eventId = t.eventId;
        if (t.used) revert TicketAlreadyUsed(tokenId);

        EventData storage ev = _getEvent(eventId);
        if (ev.cancelled) revert EventIsCancelled(eventId);
        if (block.timestamp + CHECKIN_OPENS_BEFORE < ev.startTime || block.timestamp >= ev.endTime) {
            revert CheckInWindowClosed(eventId);
        }
        if (block.timestamp > deadline) revert PassExpired(deadline);

        address holder = ticketNFT.ownerOf(tokenId);
        address signer = ECDSA.recover(
            MessageHashUtils.toEthSignedMessageHash(getCheckInDigest(tokenId, deadline)), signature
        );
        if (signer != holder) revert InvalidSignature(tokenId);

        t.used = true;
        emit TicketCheckedIn(tokenId, eventId, holder, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                               REEMBOLSOS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Reembolsa el precio de cara de una entrada de un evento cancelado y la quema.
     * @dev Si la entrada esta en reventa, primero hay que cancelar la publicacion.
     * @param tokenId Entrada.
     */
    function claimRefund(uint256 tokenId) external nonReentrant {
        TicketData storage t = ticketData[tokenId];
        uint32 eventId = t.eventId;
        EventData storage ev = _getEvent(eventId);
        if (!ev.cancelled) revert EventNotCancelled(eventId);
        if (ticketNFT.ownerOf(tokenId) != msg.sender) revert NotTicketOwner(tokenId);

        uint256 amount = ev.price;

        // Effects
        proceeds[eventId] -= amount;
        delete ticketData[tokenId];
        ticketNFT.burn(tokenId);

        // Interactions
        paymentToken.safeTransfer(msg.sender, amount);
        emit TicketRefunded(tokenId, msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 VISTAS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Digest que el titular debe firmar para generar su pase de ingreso.
     * @param tokenId Entrada.
     * @param deadline Timestamp limite del pase.
     * @return Digest keccak256 (sin prefijo EIP-191).
     */
    function getCheckInDigest(uint256 tokenId, uint256 deadline) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, tokenId, deadline));
    }

    /**
     * @notice Precio maximo de reventa de un evento (precio de cara + sobreprecio maximo).
     * @param eventId Evento.
     * @return Precio maximo permitido.
     */
    function maxResalePrice(uint32 eventId) public view returns (uint128) {
        uint128 face = events[eventId].price;
        return uint128((uint256(face) * (BPS + MAX_RESALE_MARKUP_BPS)) / BPS);
    }

    /**
     * @notice Verifica una entrada on-chain: titular, evento y si ya fue usada.
     * @dev Reemplaza la inspeccion visual de una entrada fisica: una entrada trucha simplemente no existe.
     * @param tokenId Entrada.
     * @return holder Titular actual (puede ser este contrato si esta en reventa).
     * @return eventId Evento al que pertenece.
     * @return used Si ya fue utilizada.
     * @return cancelled Si el evento fue cancelado.
     */
    function verifyTicket(uint256 tokenId)
        external
        view
        returns (address holder, uint32 eventId, bool used, bool cancelled)
    {
        holder = ticketNFT.ownerOf(tokenId); // revierte si la entrada no existe
        TicketData memory t = ticketData[tokenId];
        return (holder, t.eventId, t.used, events[t.eventId].cancelled);
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNAS
    //////////////////////////////////////////////////////////////*/

    /// @dev Devuelve el evento o revierte si no existe.
    function _getEvent(uint32 eventId) private view returns (EventData storage ev) {
        ev = events[eventId];
        if (ev.organizer == address(0)) revert EventNotFound(eventId);
    }

    /// @dev Valida que `msg.sender` pueda mover la entrada (titular, no usada, evento vigente).
    function _requireTransferable(uint256 tokenId, TicketData storage t) private view {
        if (listings[tokenId].seller != address(0)) revert AlreadyListed(tokenId);
        if (ticketNFT.ownerOf(tokenId) != msg.sender) revert NotTicketOwner(tokenId);
        if (t.used) revert TicketAlreadyUsed(tokenId);
        uint32 eventId = t.eventId;
        EventData storage ev = events[eventId];
        if (ev.cancelled) revert EventIsCancelled(eventId);
        if (block.timestamp >= ev.endTime) revert EventClosed(eventId);
    }
}
