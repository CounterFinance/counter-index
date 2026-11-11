// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// Minimal ERC-20-ish token: enough to emit real Transfer logs for the op-index
/// EVM dogfood. Not production — it skips allowances and overflow niceties.
contract MiniToken {
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint256 supply) {
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }
}
