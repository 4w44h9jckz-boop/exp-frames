// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// The operator half of an ERC-721 collection, enough for experiment 54's case (d): anyone can
/// mint, an owner can grant an operator over all its tokens, and the operator can move them.
contract TestCollection {
    mapping(uint256 => address) public ownerOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function mint(address to, uint256 id) external {
        require(ownerOf[id] == address(0), "minted");
        ownerOf[id] = to;
        emit Transfer(address(0), to, id);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "owner");
        require(msg.sender == from || isApprovedForAll[from][msg.sender], "operator");
        ownerOf[id] = to;
        emit Transfer(from, to, id);
    }
}
