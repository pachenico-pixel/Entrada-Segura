# EntradaSegura — entradas NFT anti-falsificación para eventos masivos

> Trabajo Final — Blockchain/Web3. Equipo: Nicolás Montenegro y Fabio Colman.

## 1. El problema

En la despedida de Messi en el Monumental se vendieron entradas físicas truchas: copias impresas, códigos duplicados y reventa a precios abusivos. Una entrada de papel o un QR estático **no se puede verificar de forma confiable** y se copia gratis.

## 2. ¿Por qué blockchain?

| Problema real | Cómo lo resuelve el sistema |
|---|---|
| Entradas truchas | Cada entrada es un NFT emitido **solo** por el contrato oficial. Si el id no existe on-chain, es falsa. Cualquiera puede verificarla sin confiar en nadie. |
| QR copiado / captura de pantalla | El QR no es fijo: es una **firma del titular** con vencimiento (5 min) sobre el id de la entrada. Una captura vieja no sirve. |
| Una entrada usada dos veces | `checkIn` marca la entrada como usada de forma irreversible. El segundo intento revierte. |
| Reventa abusiva | Las transferencias fuera del sistema están bloqueadas. La reventa oficial tiene **tope de +10 %** y paga 5 % al organizador. |
| Acaparamiento | Límite de entradas por billetera en la venta primaria. |
| Cancelación | Reembolso automático del precio de cara desde el contrato. |
| Falta de transparencia | Eventos on-chain para cada venta, reventa e ingreso (trazabilidad). |

Una base de datos central podría guardar lo mismo, pero obligaría a confiar en un único operador y no permitiría que terceros (hinchas, prensa, autoridades) verifiquen entradas e ingresos de forma independiente.

## 3. Arquitectura

```
                 ┌──────────────────────────┐
  Organizador ──▶│     EventTicketing       │◀── Validador (check-in)
  Hincha ───────▶│ AccessControl + Reentr.  │
                 │ eventos · venta · reventa│
                 │ check-in · reembolsos    │
                 └───────┬──────────┬───────┘
          mint/burn/     │          │ safeTransferFrom (SafeERC20)
          transfer       ▼          ▼
                 ┌────────────┐  ┌──────────┐
                 │ TicketNFT  │  │ MockUSDC │  (stablecoin de pago, 6 dec.)
                 │  ERC-721   │  └──────────┘
                 └────────────┘
```

- **`EventTicketing`**: lógica de negocio. Despliega su propio `TicketNFT` (interacción entre contratos propios) y cobra en un ERC-20 (interacción con contrato externo vía `SafeERC20`).
- **`TicketNFT`**: ERC-721 (OpenZeppelin v5) donde solo `EventTicketing` puede mintear, quemar o transferir.
- **`MockUSDC`**: ERC-20 de prueba con faucet, solo para testnet.
- **Roles**: `DEFAULT_ADMIN_ROLE` (administra roles y puede cancelar eventos), `ORGANIZER_ROLE` (crea eventos y retira fondos del suyo), `VALIDATOR_ROLE` (ejecuta check-in).

### Flujo principal
1. Organizador: `createEvent`.
2. Hincha: `approve` + `buyTickets` → recibe NFTs.
3. En el estadio: el hincha firma off-chain `getCheckInDigest(tokenId, deadline)` (QR). El validador llama `checkIn(tokenId, deadline, firma)`.
4. La entrada queda `used = true`; no se puede reutilizar, transferir ni revender.

### Decisiones de seguridad y gas
- Checks-Effects-Interactions + `ReentrancyGuard` en toda función que mueve fondos o NFTs.
- `SafeERC20` en todos los pagos. Custom errors con parámetros; sin strings de error.
- Structs empaquetados (2 slots por evento), `immutable` para `paymentToken` y `ticketNFT`, `constant` para parámetros, `unchecked` solo en contadores acotados, mint en lote (`mintBatch`).
- El nombre del evento solo se emite en un evento (no se guarda en storage).
- Sin `tx.origin`, `delegatecall`, `selfdestruct` ni `assembly`. Sin proxies.
- Firmas: EIP-191 + `ECDSA` de OpenZeppelin; el digest incluye contrato, `chainId`, `tokenId` y `deadline` (evita replay entre contratos y redes).

## 4. Instalación

Requisitos: Node 18+ y Git.

```bash
git clone https://github.com/pachenico-pixel/Entrada-Segura.git
cd Entrada-Segura
npm install
cp .env.example .env     # completar variables (ver abajo)
npx hardhat compile
```

## 5. Tests y coverage

```bash
npx hardhat test        # 35 tests
npx hardhat coverage    # reporte en ./coverage/index.html
```

Resultado obtenido (código propio, incluyendo mocks):

| Statements | Branches | Functions | Lines |
|---|---|---|---|
| 100 % | 88.14 % | 100 % | 100 % |

Los tests cubren: flujo principal exitoso, límites por billetera, capacidad, reventa con tope y comisión, restricción de transferencias ERC-721, check-in (firma válida, firma ajena, pase vencido, reuso, ventana horaria, cambio de titular tras reventa), cancelación, reembolsos y retiro de fondos, y múltiples reverts por control de acceso.

## 6. Análisis estático (Slither)

```bash
pip install slither-analyzer
npx hardhat compile
slither . --hardhat-ignore-compile --filter-paths "node_modules|mocks"
```

Reporte de la última ejecución: [`docs/slither-report.txt`](docs/slither-report.txt).

| Finding | Estado | Justificación |
|---|---|---|
| `calls-loop` en `buyTickets` | **Corregido** | Se reemplazó el mint por llamada por `mintBatch` (una sola llamada externa). |
| `reentrancy-benign` en `buyTickets` | **Corregido** | `ticketData` se escribe antes de cualquier llamada externa. |
| `reentrancy-no-eth` en `claimRefund` | **Corregido** | `delete ticketData` se ejecuta antes de `burn`. Además la función es `nonReentrant`. |
| `unused-return` en `buyTickets` | **Corregido** | El valor de `mintBatch` se compara con los ids registrados (`TokenIdMismatch`). |
| `timestamp` (7 instancias) | **Aceptado** | Las ventanas de tiempo (venta, check-in, retiro) son de horas/días; una manipulación de segundos por el validador no altera el resultado. |

## 7. Ejecutar el proyecto

### Local
```bash
npx hardhat node                                   # terminal 1
npm run deploy:local                               # terminal 2: despliega y genera frontend/config.js
npm run demo:local                                 # recorre el flujo completo por script
npm run frontend                                   # abre http://localhost:3000
```
En MetaMask agregá la red `http://127.0.0.1:8545` (chainId 31337) e importá una cuenta del nodo (la primera ya tiene todos los roles).

### Sepolia
1. Completar `.env` con `SEPOLIA_RPC_URL`, `PRIVATE_KEY` (**de una wallet de prueba**) y `ETHERSCAN_API_KEY`. La wallet necesita ETH de Sepolia (se consigue en un faucet).
2. `npm run deploy:sepolia` — despliega, otorga roles al deployer, intenta verificar y escribe `deployments/sepolia.json` y `frontend/config.js`.
3. `npm run demo:sepolia` — ejecuta el flujo real on-chain e imprime los hashes.
4. Si la verificación automática falla: `npx hardhat verify --network sepolia <address> <args>` (los argumentos están en `scripts/deploy.js`).

Los resultados de este despliegue están en las secciones 8 y 9.

### Frontend
Sitio estático sin build (HTML + ethers v6). Pestañas: **Hinchas** (verificar entrada sin billetera, comprar, mostrar pase QR, regalar, revender, reembolso), **Organizador** (crear/cancelar eventos, retirar fondos, otorgar roles) y **Acceso** (pegar el pase y registrar ingreso). Para correrlo: `npm run frontend`. El archivo `frontend/config.js` se genera en cada deploy: tras `npm run deploy:sepolia` queda apuntando a los contratos de la sección 8, y para operar hay que conectar MetaMask a la red Sepolia. Publicarlo en Vercel o Netlify (subiendo la carpeta `frontend/`) es opcional.

## 8. Despliegue en Sepolia

Red: Sepolia (chainId 11155111). Bloque de despliegue: 12129160.

| Contrato | Dirección | Código verificado |
|---|---|---|
| MockUSDC | `0x80326c266bC0D62fb9B27ca01921Fe3a983E42da` | [Ver en Etherscan](https://sepolia.etherscan.io/address/0x80326c266bC0D62fb9B27ca01921Fe3a983E42da#code) |
| EventTicketing | `0xcfd9C1A9f6C1B1F88Cded53e81f23a8f0bcFeED4` | [Ver en Etherscan](https://sepolia.etherscan.io/address/0xcfd9C1A9f6C1B1F88Cded53e81f23a8f0bcFeED4#code) |
| TicketNFT | `0x17feD29d5CCA8B6B59EfCEF084D60c25da91061f` | [Ver en Etherscan](https://sepolia.etherscan.io/address/0x17feD29d5CCA8B6B59EfCEF084D60c25da91061f#code) |

## 9. Transacciones reales del flujo principal (Sepolia)

Generadas con `npm run demo:sepolia` sobre los contratos de la sección 8:

| Paso | Hash |
|---|---|
| createEvent | [`0xae7b49826dd87f58261c8ef451474267eacb5b3b78b36d0cc39386eb96a4e3e5`](https://sepolia.etherscan.io/tx/0xae7b49826dd87f58261c8ef451474267eacb5b3b78b36d0cc39386eb96a4e3e5) |
| buyTickets (x2) | [`0xffb15cde3d782456150528f082fa303546f5e0e3e895953f5eb6379d465dbe2e`](https://sepolia.etherscan.io/tx/0xffb15cde3d782456150528f082fa303546f5e0e3e895953f5eb6379d465dbe2e) |
| listForResale | [`0x47cb24532085e1a4621c404171e1cb62d5c5eb63ce2c9f48c9ae4f83a9b97812`](https://sepolia.etherscan.io/tx/0x47cb24532085e1a4621c404171e1cb62d5c5eb63ce2c9f48c9ae4f83a9b97812) |
| cancelListing | [`0xcfd64dd4af83bb4286a3b2769f52a4276ffe1c62d9256456875c9091d64b001a`](https://sepolia.etherscan.io/tx/0xcfd64dd4af83bb4286a3b2769f52a4276ffe1c62d9256456875c9091d64b001a) |
| checkIn | [`0x428948b9bb92160c79fd72c570a55b57f141672d91a0b2982b80c1db9b2e6d1f`](https://sepolia.etherscan.io/tx/0x428948b9bb92160c79fd72c570a55b57f141672d91a0b2982b80c1db9b2e6d1f) |

Al reintentar el `checkIn` de la misma entrada, el contrato revierte con el error `TicketAlreadyUsed` (verificado con `staticCall` en `scripts/demo.js`). Estado final de la entrada #1: `usada = true`.

## 10. Limitaciones conocidas del MVP
- El pase de ingreso lo firma el titular con su billetera (cada pase dura 5 min); en producción se usaría una *session key* o una app con QR rotativo automático.
- Un único `VALIDATOR_ROLE` global (no por evento).
- No se soportan billeteras de contrato (ERC-1271) para firmar el pase.
- Las entradas "regaladas" pueden venderse fuera del sistema; el tope solo aplica a la reventa oficial. Igualmente, la entrada comprada siempre es verificable y única.
- Reembolso al precio de cara (no al precio pagado en reventa).
- El frontend lista entradas recorriendo ids (suficiente para demo; en producción se usaría un indexador/subgraph).
- Los metadatos (`tokenURI`) apuntan a una URL de ejemplo.
- Contratos sin auditoría profesional.

## 11. Roadmap

**Fase 2 — Producto**
- Zonas y asientos numerados (precio por sector), venta por rondas y lista de espera.
- Pagos con USDC real y soporte de pagos en pesos mediante on-ramp.
- Validador por evento y app móvil de escaneo con cámara; modo offline con verificación de firma local.
- Metadatos dinámicos (IPFS) y entrada coleccionable post-evento (POAP).

**Fase 3 — Seguridad y escalabilidad**
- Auditoría externa, fuzzing e invariant tests (Foundry/Echidna), multisig + timelock para el rol admin.
- ERC-1271 para smart wallets y *account abstraction* para que el hincha no pague gas.
- Despliegue en un L2 (Base/Arbitrum/Optimism) para costos mínimos; indexación con The Graph.
- Identidad (KYC liviano / prueba de humanidad) para limitar compras múltiples con billeteras distintas.

## 12. Video de presentación y demo

Duración: máximo 5 minutos.

**Enlace al video:** _completar con el link (YouTube, Drive u otro)_

## 13. Estructura
```
contracts/   EventTicketing.sol, TicketNFT.sol, mocks/MockUSDC.sol  (NatSpec completo)
test/        EventTicketing.test.js
scripts/     deploy.js, demo.js
frontend/    index.html, app.js, styles.css, config.js
docs/        slither-report.txt
```

Licencia: MIT.
