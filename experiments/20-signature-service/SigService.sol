// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// Reads the transaction's signature list through SigReader. Inside a frame transaction, every
/// SECP256K1 and P256 entry has been verified by the protocol before the first frame ran, so a
/// contract only has to check that the entry says the right thing: who signed (`signer`) and
/// what (`msg`). It never sees the signature bytes, and it does not care which scheme was used.
abstract contract SigUser {
    struct Entry {
        uint256 scheme;
        address signer;
        bytes32 msg;
    }

    address public immutable reader;

    constructor(address reader_) {
        reader = reader_;
    }

    function _entries(uint256 first, uint256 n) internal view returns (Entry[] memory out) {
        (bool ok, bytes memory ret) = reader.staticcall(abi.encode(first, n));
        require(ok, "sigreader");
        out = new Entry[](n);
        for (uint256 i = 0; i < n; i++) {
            (uint256 scheme, uint256 signer, bytes32 m) = abi.decode(_slice(ret, i * 96), (uint256, uint256, bytes32));
            out[i] = Entry(scheme, address(uint160(signer)), m);
        }
    }

    /// True if entry `index` is a protocol-verified signature by `signer` over `digest`.
    /// `digest` is never 0 in practice (a keccak output), so an entry with `msg` ∅, which reads
    /// as 0, never matches.
    function _signedBy(uint256 index, address signer, bytes32 digest) internal view returns (bool) {
        Entry memory e = _entries(index, 1)[0];
        return (e.scheme == 1 || e.scheme == 2) && e.signer == signer && e.msg == digest;
    }

    function _slice(bytes memory b, uint256 offset) private pure returns (bytes memory out) {
        out = new bytes(96);
        assembly {
            mcopy(add(out, 32), add(add(b, 32), offset), 96)
        }
    }
}

/// EIP-712 helpers, and the two in-EVM verifiers the protocol path is compared with.
abstract contract Eip712 {
    bytes32 public immutable DOMAIN_SEPARATOR;
    uint256 private constant SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint256 private constant P256_HALF_N = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8;

    constructor(string memory name) {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", DOMAIN_SEPARATOR, structHash));
    }

    /// The same checks the protocol makes for SECP256K1: v 0 or 1, 0 < r, low s.
    function _ecrecover(bytes32 digest, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {
        require(v < 2 && uint256(r) != 0 && uint256(s) != 0 && uint256(s) <= SECP256K1_HALF_N, "sig encoding");
        address a = ecrecover(digest, v + 27, r, s);
        require(a != address(0), "ecrecover");
        return a;
    }

    /// The same checks the protocol makes for P256: low s, signer = keccak256(qx ‖ qy)[12:].
    function _p256(bytes32 digest, bytes32 r, bytes32 s, bytes32 qx, bytes32 qy) internal view returns (address) {
        require(uint256(r) != 0 && uint256(s) != 0 && uint256(s) <= P256_HALF_N, "sig encoding");
        (bool ok, bytes memory ret) = address(0x100).staticcall(abi.encode(digest, r, s, qx, qy));
        require(ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1, "p256verify");
        return address(uint160(uint256(keccak256(abi.encode(qx, qy)))));
    }
}

/// An ERC-20 whose holders can move tokens by signature alone: a holder needs no account, no
/// ETH and no code, only a key. The P256 case is the interesting one: the holder's address is
/// keccak256(qx ‖ qy)[12:], an address that has no secp256k1 key and could never send a
/// transaction of its own.
contract SigToken is SigUser, Eip712 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;

    bytes32 public constant TRANSFER_TYPEHASH = keccak256("Transfer(address from,address to,uint256 value,uint256 nonce)");
    bytes32 public constant APPROVE_TYPEHASH = keccak256("Approve(address owner,address spender,uint256 value,uint256 nonce)");

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address reader_, string memory name_, string memory symbol_) SigUser(reader_) Eip712(name_) {
        name = name_;
        symbol = symbol_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function transferDigest(address from, address to, uint256 value, uint256 nonce) public view returns (bytes32) {
        return _digest(keccak256(abi.encode(TRANSFER_TYPEHASH, from, to, value, nonce)));
    }

    function approveDigest(address owner, address spender, uint256 value, uint256 nonce) public view returns (bytes32) {
        return _digest(keccak256(abi.encode(APPROVE_TYPEHASH, owner, spender, value, nonce)));
    }

    /// The protocol path: entry `index` must be `from`'s signature over the transfer digest.
    function transferBySig(address from, address to, uint256 value, uint256 index) external {
        require(_signedBy(index, from, transferDigest(from, to, value, nonces[from]++)), "not signed");
        _transfer(from, to, value);
    }

    /// The same transfer, with the signature checked in the EVM by ecrecover.
    function transferByEcrecover(address from, address to, uint256 value, uint8 v, bytes32 r, bytes32 s) external {
        require(_ecrecover(transferDigest(from, to, value, nonces[from]++), v, r, s) == from, "not signed");
        _transfer(from, to, value);
    }

    /// The same transfer, with the signature checked in the EVM by the P256VERIFY precompile.
    function transferByP256(address from, address to, uint256 value, bytes32 r, bytes32 s, bytes32 qx, bytes32 qy) external {
        require(_p256(transferDigest(from, to, value, nonces[from]++), r, s, qx, qy) == from, "not signed");
        _transfer(from, to, value);
    }

    /// A permit through the protocol path.
    function approveBySig(address owner, address spender, uint256 value, uint256 index) external {
        require(_signedBy(index, owner, approveDigest(owner, spender, value, nonces[owner]++)), "not signed");
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// A signed-order exchange. The maker signs an order off chain; a taker fills it in a frame
/// transaction that carries the maker's signature as an explicit-digest entry.
contract Exchange is SigUser, Eip712 {
    struct Order {
        address maker;
        address sellToken;
        uint256 sellAmount;
        address buyToken;
        uint256 buyAmount;
        address taker; // 0: anyone
        uint256 expiry;
        uint256 salt;
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address sellToken,uint256 sellAmount,address buyToken,uint256 buyAmount,address taker,uint256 expiry,uint256 salt)"
    );
    mapping(bytes32 => bool) public filled;

    event Filled(bytes32 indexed digest, address indexed maker, address indexed taker);

    constructor(address reader_) SigUser(reader_) Eip712("Exchange") {}

    function orderDigest(Order calldata o) public view returns (bytes32) {
        return _digest(keccak256(abi.encode(ORDER_TYPEHASH, o)));
    }

    function fill(Order calldata o, uint256 index) external {
        bytes32 d = orderDigest(o);
        require(!filled[d], "filled");
        require(o.taker == address(0) || o.taker == msg.sender, "taker");
        require(block.timestamp <= o.expiry, "expired");
        require(_signedBy(index, o.maker, d), "not signed");
        filled[d] = true;
        require(IERC20(o.sellToken).transferFrom(o.maker, msg.sender, o.sellAmount), "sell");
        require(IERC20(o.buyToken).transferFrom(msg.sender, o.maker, o.buyAmount), "buy");
        emit Filled(d, o.maker, msg.sender);
    }
}

/// Counts distinct signers over one vote, three ways. Signers must be in strictly ascending
/// order, which is how distinctness is checked without storage.
contract Quorum is SigUser, Eip712 {
    bytes32 public constant VOTE_TYPEHASH = keccak256("Vote(uint256 proposal,uint8 choice)");

    event Counted(uint256 indexed proposal, uint8 choice, uint256 votes, uint256 method);

    constructor(address reader_) SigUser(reader_) Eip712("Quorum") {}

    function voteDigest(uint256 proposal, uint8 choice) public view returns (bytes32) {
        return _digest(keccak256(abi.encode(VOTE_TYPEHASH, proposal, choice)));
    }

    /// Entries first .. first + n - 1 of the transaction's signature list.
    function countBySig(uint256 proposal, uint8 choice, uint256 first, uint256 n) external {
        bytes32 d = voteDigest(proposal, choice);
        Entry[] memory es = _entries(first, n);
        address last;
        for (uint256 i = 0; i < n; i++) {
            Entry memory e = es[i];
            require((e.scheme == 1 || e.scheme == 2) && e.msg == d, "not signed");
            require(e.signer > last, "order");
            last = e.signer;
        }
        emit Counted(proposal, choice, n, 0);
    }

    /// `sigs` is n × (v (1) ‖ r (32) ‖ s (32)).
    function countByEcrecover(uint256 proposal, uint8 choice, bytes calldata sigs) external {
        bytes32 d = voteDigest(proposal, choice);
        uint256 n = sigs.length / 65;
        address last;
        for (uint256 i = 0; i < n; i++) {
            bytes calldata s = sigs[i * 65:(i + 1) * 65];
            address a = _ecrecover(d, uint8(s[0]), bytes32(s[1:33]), bytes32(s[33:65]));
            require(a > last, "order");
            last = a;
        }
        emit Counted(proposal, choice, n, 1);
    }

    /// `sigs` is n × (r ‖ s ‖ qx ‖ qy), 128 bytes each.
    function countByP256(uint256 proposal, uint8 choice, bytes calldata sigs) external {
        bytes32 d = voteDigest(proposal, choice);
        uint256 n = sigs.length / 128;
        address last;
        for (uint256 i = 0; i < n; i++) {
            bytes calldata s = sigs[i * 128:(i + 1) * 128];
            address a = _p256(d, bytes32(s[0:32]), bytes32(s[32:64]), bytes32(s[64:96]), bytes32(s[96:128]));
            require(a > last, "order");
            last = a;
        }
        emit Counted(proposal, choice, n, 2);
    }
}
