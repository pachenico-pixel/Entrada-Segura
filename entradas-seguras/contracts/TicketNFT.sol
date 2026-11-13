// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/**
 * @title TicketNFT
 * @author EntradaSegura
 * @notice Entrada digital (ERC-721) cuya unica fuente de emision es `EventTicketing`.
 * @dev Las entradas NO pueden moverse por las vias estandar de ERC-721: cualquier
 *      mint, burn o transferencia solo es posible si la llamada proviene del contrato
 *      `ticketing`. Esto evita reventa descontrolada en marketplaces externos y obliga
 *      a que toda transferencia pase por las reglas del sistema (tope de reventa,
 *      comision al organizador, control de uso).
 *      Roles / privilegios: unico privilegiado = `ticketing` (inmutable, fijado en el constructor).
 */
contract TicketNFT is ERC721 {
    /// @notice URI base de metadatos de cada entrada. Se concatena con el tokenId.
    string private constant BASE_URI = "https://entradas-seguras.example/api/ticket/";

    /// @notice Contrato autorizado a mintear, quemar y transferir entradas.
    address public immutable ticketing;

    /// @notice Proximo tokenId a emitir (comienza en 1; 0 nunca es un id valido).
    uint256 public nextTokenId = 1;

    /// @notice El llamante no es el contrato `ticketing`.
    error NotTicketing();

    /// @notice Se intento mover una entrada fuera del flujo del sistema.
    error TransferRestricted();

    /// @notice Direccion cero no permitida.
    error ZeroAddress();

    /// @dev Restringe la funcion al contrato `ticketing`.
    modifier onlyTicketing() {
        if (msg.sender != ticketing) revert NotTicketing();
        _;
    }

    /**
     * @param name_ Nombre de la coleccion.
     * @param symbol_ Simbolo de la coleccion.
     * @param ticketing_ Direccion del contrato `EventTicketing` que administra las entradas.
     */
    constructor(string memory name_, string memory symbol_, address ticketing_) ERC721(name_, symbol_) {
        if (ticketing_ == address(0)) revert ZeroAddress();
        ticketing = ticketing_;
    }

    /**
     * @notice Emite `quantity` entradas consecutivas a `to`.
     * @param to Destinatario de las entradas.
     * @param quantity Cantidad a emitir.
     * @return firstTokenId Primer identificador emitido; los siguientes son consecutivos.
     */
    function mintBatch(address to, uint256 quantity) external onlyTicketing returns (uint256 firstTokenId) {
        firstTokenId = nextTokenId;
        for (uint256 i; i < quantity;) {
            _mint(to, firstTokenId + i);
            unchecked {
                ++i; // seguro: i < quantity
            }
        }
        unchecked {
            // seguro: no se pueden emitir 2^256 entradas
            nextTokenId = firstTokenId + quantity;
        }
    }

    /**
     * @notice Quema una entrada (usado en reembolsos por cancelacion).
     * @param tokenId Entrada a quemar.
     */
    function burn(uint256 tokenId) external onlyTicketing {
        _burn(tokenId);
    }

    /**
     * @notice Transfiere una entrada entre dos cuentas. Solo lo puede invocar `ticketing`.
     * @param from Propietario actual.
     * @param to Nuevo propietario.
     * @param tokenId Entrada a transferir.
     */
    function ticketTransfer(address from, address to, uint256 tokenId) external onlyTicketing {
        _transfer(from, to, tokenId);
    }

    /// @inheritdoc ERC721
    function _baseURI() internal pure override returns (string memory) {
        return BASE_URI;
    }

    /**
     * @dev Bloquea toda mutacion de propiedad que no provenga de `ticketing`.
     *      Cubre transferFrom / safeTransferFrom hechos por usuarios u operadores aprobados.
     */
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (msg.sender != ticketing) revert TransferRestricted();
        return super._update(to, tokenId, auth);
    }
}
