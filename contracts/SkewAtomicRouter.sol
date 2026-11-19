// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IUniswapV3PoolMinimal {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/**
 * @title SkewAtomicRouter
 * @notice Non-custodial, zero-balance atomic settlement router for Skew (ERC-8004 Agent #9905).
 *         Settles Uniswap v3 optimistic flash-swaps against Textile v2 RFQ quotes in a single
 *         atomic transaction and sweeps 100% of net USDT profit to `owner` (reverts if unprofitable).
 */
contract SkewAtomicRouter {
    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    address public immutable owner;
    address public immutable usdt;
    address public immutable reactor;
    address private expectedCallbackPool;

    error Unauthorized();
    error InvalidCallback();
    error InvalidTarget();
    error InsufficientProfit(uint256 actual, uint256 required);
    error SettlementFailed();
    error ERC20CallFailed();

    struct FlashParams {
        address pool;
        address fxToken;
        bool isTextileToUni;
        uint256 takerPays;
        uint256 buyAmount;
        uint256 minProfitUsdt;
        address spender;
        address swapTarget;
        bytes swapData;
    }

    constructor(address _owner, address _usdt, address _reactor) {
        if (_owner == address(0) || _usdt == address(0) || _reactor == address(0)) revert InvalidTarget();
        owner = _owner;
        usdt = _usdt;
        reactor = _reactor;
    }

    function executeFlashArb(FlashParams calldata p) external returns (uint256 profitUsdt) {
        if (msg.sender != owner) revert Unauthorized();
        if (expectedCallbackPool != address(0)) revert InvalidCallback();
        if (
            p.pool == address(0) ||
            p.fxToken == address(0) ||
            p.fxToken == usdt ||
            p.spender == address(0) ||
            p.swapTarget == address(0) ||
            p.swapTarget == usdt ||
            p.swapTarget == p.fxToken ||
            p.swapTarget == p.pool
        ) {
            revert InvalidTarget();
        }

        // Direction 1 (isTextileToUni = true): sell exact `buyAmount` of fxToken into pool -> pool sends USDT first
        // Direction 2 (isTextileToUni = false): buy exact `takerPays` of fxToken from pool -> pool sends fxToken first
        bool zeroForOne = p.isTextileToUni ? (p.fxToken < usdt) : (usdt < p.fxToken);
        int256 amountSpecified = p.isTextileToUni ? int256(p.buyAmount) : -int256(p.takerPays);
        uint160 sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE;

        expectedCallbackPool = p.pool;
        IUniswapV3PoolMinimal(p.pool).swap(
            address(this),
            zeroForOne,
            amountSpecified,
            sqrtPriceLimitX96,
            abi.encode(p, zeroForOne)
        );
        expectedCallbackPool = address(0);

        profitUsdt = IERC20Minimal(usdt).balanceOf(address(this));
        if (profitUsdt < p.minProfitUsdt) {
            revert InsufficientProfit(profitUsdt, p.minProfitUsdt);
        }
        _safeTransfer(usdt, owner, profitUsdt);

        uint256 fxDust = IERC20Minimal(p.fxToken).balanceOf(address(this));
        if (fxDust > 0) {
            _safeTransfer(p.fxToken, owner, fxDust);
        }
    }

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        address pool = expectedCallbackPool;
        if (msg.sender != pool || pool == address(0)) revert InvalidCallback();
        expectedCallbackPool = address(0);

        (FlashParams memory p, bool zeroForOne) = abi.decode(data, (FlashParams, bool));

        if (p.isTextileToUni) {
            // Pool already sent us USDT (`-(amount1Delta)` if zeroForOne else `-(amount0Delta)`)
            uint256 usdtReceived = uint256(-(zeroForOne ? amount1Delta : amount0Delta));
            if (usdtReceived < p.takerPays + p.minProfitUsdt) {
                revert InsufficientProfit(usdtReceived, p.takerPays + p.minProfitUsdt);
            }
            uint256 fxOwed = uint256(zeroForOne ? amount0Delta : amount1Delta);

            _approveSpender(usdt, p.spender, p.takerPays);
            (bool ok, ) = p.swapTarget.call(p.swapData);
            if (!ok) revert SettlementFailed();
            if (p.spender != reactor && IERC20Minimal(usdt).allowance(address(this), p.spender) > 0) {
                _safeApprove(usdt, p.spender, 0);
            }

            _safeTransfer(p.fxToken, pool, fxOwed);
        } else {
            // Pool already sent us exact `p.takerPays` of fxToken; we owe `usdtOwed` of USDT
            uint256 usdtOwed = uint256(zeroForOne ? amount0Delta : amount1Delta);
            if (p.buyAmount < usdtOwed + p.minProfitUsdt) {
                revert InsufficientProfit(p.buyAmount, usdtOwed + p.minProfitUsdt);
            }

            _approveSpender(p.fxToken, p.spender, p.takerPays);
            (bool ok, ) = p.swapTarget.call(p.swapData);
            if (!ok) revert SettlementFailed();
            if (p.spender != reactor && IERC20Minimal(p.fxToken).allowance(address(this), p.spender) > 0) {
                _safeApprove(p.fxToken, p.spender, 0);
            }

            uint256 usdtBal = IERC20Minimal(usdt).balanceOf(address(this));
            if (usdtBal < usdtOwed + p.minProfitUsdt) {
                revert InsufficientProfit(usdtBal, usdtOwed + p.minProfitUsdt);
            }
            _safeTransfer(usdt, pool, usdtOwed);
        }
    }

    function rescueTokens(address token) external {
        if (msg.sender != owner) revert Unauthorized();
        uint256 bal = IERC20Minimal(token).balanceOf(address(this));
        if (bal > 0) _safeTransfer(token, owner, bal);
    }

    function _approveSpender(address token, address spender, uint256 required) private {
        uint256 curr = IERC20Minimal(token).allowance(address(this), spender);
        if (curr < required) {
            if (curr > 0) _safeApprove(token, spender, 0);
            _safeApprove(token, spender, spender == reactor ? type(uint256).max : required);
        }
    }

    function _safeApprove(address token, address spender, uint256 value) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, value));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert ERC20CallFailed();
    }

    function _safeTransfer(address token, address to, uint256 value) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, value));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert ERC20CallFailed();
    }
}
