// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Swaps tokenIn for tokenOut 1:1 out of its own reserves. A toy: no pricing, no fees.
contract ToyDex {
    IERC20 public immutable tokenIn;
    IERC20 public immutable tokenOut;

    event Swap(address indexed trader, uint256 amountIn, uint256 amountOut);

    constructor(IERC20 tokenIn_, IERC20 tokenOut_) {
        tokenIn = tokenIn_;
        tokenOut = tokenOut_;
    }

    /// Pulls `amountIn` of tokenIn (needs an allowance) and pays out the same amount of tokenOut.
    /// Reverts with "slippage" when the output would be below `minOut`.
    function swap(uint256 amountIn, uint256 minOut) external returns (uint256 amountOut) {
        amountOut = amountIn;
        require(amountOut >= minOut, "slippage");
        require(tokenIn.transferFrom(msg.sender, address(this), amountIn), "pull");
        require(tokenOut.transfer(msg.sender, amountOut), "push");
        emit Swap(msg.sender, amountIn, amountOut);
    }
}
