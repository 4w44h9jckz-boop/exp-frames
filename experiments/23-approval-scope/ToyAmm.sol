// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

interface IERC20 {
    function balanceOf(address who) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// A constant-product pool over two tokens, with no fee: enough for a price to move when someone
/// trades ahead of you. Reserves are whatever the pool holds when `sync` or a swap last ran.
contract ToyAmm {
    IERC20 public immutable a;
    IERC20 public immutable b;
    uint256 public reserveA;
    uint256 public reserveB;

    event Swap(address indexed trader, bool aToB, uint256 amountIn, uint256 amountOut);

    constructor(IERC20 a_, IERC20 b_) {
        a = a_;
        b = b_;
    }

    function sync() external {
        reserveA = a.balanceOf(address(this));
        reserveB = b.balanceOf(address(this));
    }

    function quote(bool aToB, uint256 amountIn) public view returns (uint256) {
        (uint256 rIn, uint256 rOut) = aToB ? (reserveA, reserveB) : (reserveB, reserveA);
        return (amountIn * rOut) / (rIn + amountIn);
    }

    /// Pulls `amountIn` from the caller (needs an allowance) and sends the output to `to`.
    /// Reverts with "slippage" when the output would be below `minOut`.
    function swap(bool aToB, uint256 amountIn, uint256 minOut, address to) external returns (uint256 amountOut) {
        amountOut = quote(aToB, amountIn);
        require(amountOut >= minOut, "slippage");
        (IERC20 tokenIn, IERC20 tokenOut) = aToB ? (a, b) : (b, a);
        require(tokenIn.transferFrom(msg.sender, address(this), amountIn), "pull");
        require(tokenOut.transfer(to, amountOut), "push");
        if (aToB) {
            reserveA += amountIn;
            reserveB -= amountOut;
        } else {
            reserveB += amountIn;
            reserveA -= amountOut;
        }
        emit Swap(msg.sender, aToB, amountIn, amountOut);
    }
}

/// The attacker's bot. It holds Token A, buys B ahead of a victim and sells it back after.
/// Anyone may call it: in a DEFAULT frame the caller is the entry point, not the attacker, and the
/// bot only ever trades its own balance.
contract Sandwicher {
    ToyAmm public immutable amm;
    IERC20 public immutable a;
    IERC20 public immutable b;

    constructor(ToyAmm amm_) {
        amm = amm_;
        a = amm_.a();
        b = amm_.b();
        a.approve(address(amm_), type(uint256).max);
        b.approve(address(amm_), type(uint256).max);
    }

    function front(uint256 amountA) external {
        amm.swap(true, amountA, 0, address(this));
    }

    function back() external {
        amm.swap(false, b.balanceOf(address(this)), 0, address(this));
    }
}
