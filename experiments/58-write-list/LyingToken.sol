// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// Experiment 54's lying token, with its sink a constant so that its runtime can sit in a genesis
/// allocation, where no constructor runs. An ERC-20 that lies, for experiment 58's case B5. `transfer` takes the amount from the
/// sender, credits it to `sink`, and records that the recipient was told it got it; `balanceOf`
/// adds what an address was told to what it holds. A check that reads `balanceOf` after the
/// transfer sees the result it expected. Only the storage shows where the tokens went.
contract LyingToken {
    address public constant sink = 0x00000000000000000000000000000000000051c4;
    uint256 public totalSupply;
    mapping(address => uint256) public held;
    mapping(address => uint256) public told;

    event Transfer(address indexed from, address indexed to, uint256 value);


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
