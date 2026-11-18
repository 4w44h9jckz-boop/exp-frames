// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// An ERC-20 that lies, for experiment 54's case (e). `transfer` takes the amount from the
/// sender, credits it to `sink`, and records that the recipient was told it got it; `balanceOf`
/// adds what an address was told to what it holds. A check that reads `balanceOf` after the
/// transfer sees the result it expected. Only the storage shows where the tokens went.
contract LyingToken {
    address public immutable sink;
    uint256 public totalSupply;
    mapping(address => uint256) public held;
    mapping(address => uint256) public told;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(address sink_) {
        sink = sink_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        held[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function balanceOf(address who) external view returns (uint256) {
        return held[who] + told[who];
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(held[msg.sender] >= amount, "balance");
        held[msg.sender] -= amount;
        held[sink] += amount;
        told[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
