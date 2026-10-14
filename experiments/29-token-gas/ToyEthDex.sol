// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

interface IERC20 {
    function balanceOf(address who) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// A constant-product pool of one token against ETH, one direction only: token in, ETH out.
/// A toy: no fee, no liquidity shares. Liquidity is whatever token and ETH it holds.
contract ToyEthDex {
    IERC20 public immutable token;

    event Swap(address indexed trader, uint256 amountIn, uint256 amountOut);

    constructor(IERC20 token_) {
        token = token_;
    }

    receive() external payable {}

    function quote(uint256 amountIn) public view returns (uint256) {
        uint256 t = token.balanceOf(address(this));
        return (amountIn * address(this).balance) / (t + amountIn);
    }

    /// Pulls `amountIn` of the token (needs an allowance) and sends the caller ETH.
    /// Reverts with "slippage" when the output would be below `minOut`.
    function swapForEth(uint256 amountIn, uint256 minOut) external returns (uint256 amountOut) {
        amountOut = quote(amountIn);
        require(amountOut >= minOut, "slippage");
        require(token.transferFrom(msg.sender, address(this), amountIn), "pull");
        (bool ok, ) = msg.sender.call{value: amountOut}("");
        require(ok, "push");
        emit Swap(msg.sender, amountIn, amountOut);
    }
}
