// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @author EntradaSegura
 * @notice Stablecoin de prueba (6 decimales) con faucet publico. SOLO PARA TESTNET / DEMO.
 * @dev No tiene control de acceso a proposito: cualquiera puede acunar hasta `MAX_MINT` por llamada.
 */
contract MockUSDC is ERC20 {
    /// @notice Maximo acunable por llamada (10.000 mUSDC).
    uint256 public constant MAX_MINT = 10_000e6;

    /// @notice Se intento acunar mas que `MAX_MINT`.
    /// @param requested Monto pedido.
    /// @param max Monto maximo permitido.
    error MintTooLarge(uint256 requested, uint256 max);

    constructor() ERC20("Mock USDC", "mUSDC") {}

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /**
     * @notice Faucet de pruebas.
     * @param to Destinatario.
     * @param amount Monto en unidades minimas (6 decimales).
     */
    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge(amount, MAX_MINT);
        _mint(to, amount);
    }
}
