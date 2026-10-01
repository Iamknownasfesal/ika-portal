// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.28;

/// @title IkaAccount
/// @notice EIP-7702 delegate for EOAs whose key is an Ika dWallet.
///
/// The EOA (a dWallet-controlled secp256k1 key) delegates its code to this contract. Every privileged
/// action is authorized by an EIP-712 signature that recovers to `address(this)` -- i.e. to the EOA
/// itself -- so any relayer can submit the call and pay gas. An optional recovery key can take over
/// after a time lock, and the dWallet can cancel a pending recovery.
///
/// Security notes:
/// - Under EIP-7702 the EOA private key (the dWallet) can still send raw transactions from the EOA,
///   bypassing this contract entirely. That is accepted by design: the dWallet only signs what the
///   Solana `ika_account` policy approves, so both paths are gated by the same policy.
/// - All storage lives in an ERC-7201 namespaced slot so it cannot collide with storage written by a
///   previous or future delegate.
/// - The EIP-712 domain separator is computed on every call from `block.chainid` and
///   `address(this)`. It must NOT be cached in an immutable: this code runs at many addresses via
///   delegation, and an immutable would bake in the implementation's own address.
/// - `initialize` cannot be front-run: the `Init` signature is bound (through the domain) to
///   `address(this)` and the chain id, so only the EOA's key can produce it and only this EOA's
///   storage can be initialized with it. `Init` carries no nonce; it is single-use because
///   `initialized` is set once. (If the EOA later re-delegates to code that wipes this namespace, the
///   old `Init` could be replayed -- only the EOA key itself can re-delegate, so that is in scope of
///   the key's authority.)
/// - `execute` increments the nonce BEFORE the external call, so a re-entrant call cannot replay the
///   same signature; any re-entrant `execute` needs a fresh signature for the next nonce.
contract IkaAccount {
    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    error InvalidSignature();
    error Expired();
    error AlreadyInitialized();
    error NotInitialized();
    error NotRecoveryKey();
    error RecoveryNotReady();
    error InvalidRecoveryDelay();
    /// @notice Thrown when a call fails without revert data. When the callee returns revert data it
    /// is bubbled up verbatim instead.
    error CallFailed();

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    event Initialized(address indexed recoveryKey, uint256 recoveryDelay);
    /// @param nonce The nonce consumed by this execution (the value signed over).
    event Executed(uint256 indexed nonce, address indexed to, uint256 value, bytes data);
    event RecoveryInitiated(uint256 readyAt);
    /// @param nonce The nonce consumed by the cancellation (the value signed over).
    event RecoveryCancelled(uint256 indexed nonce);
    event RecoveryExecuted(address indexed to, uint256 value, bytes data);

    // ---------------------------------------------------------------------------------------------
    // EIP-712
    // ---------------------------------------------------------------------------------------------

    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant NAME_HASH = keccak256("IkaAccount");
    bytes32 public constant VERSION_HASH = keccak256("1");

    bytes32 public constant EXECUTE_TYPEHASH =
        keccak256("Execute(address to,uint256 value,bytes data,uint256 nonce,uint256 deadline)");
    bytes32 public constant INIT_TYPEHASH = keccak256("Init(address recoveryKey,uint256 recoveryDelay)");
    bytes32 public constant CANCEL_RECOVERY_TYPEHASH = keccak256("CancelRecovery(uint256 nonce,uint256 deadline)");

    /// @dev secp256k1n / 2. Signatures with s above this are rejected (EIP-2 malleability).
    uint256 internal constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 internal constant ERC1271_INVALID = 0xffffffff;

    // ---------------------------------------------------------------------------------------------
    // Storage (ERC-7201)
    // ---------------------------------------------------------------------------------------------

    /// @custom:storage-location erc7201:ika.account.storage.v1
    struct AccountStorage {
        bool initialized;
        address recoveryKey;
        uint256 recoveryDelay;
        uint256 nonce;
        uint256 recoveryReadyAt;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("ika.account.storage.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 public constant STORAGE_SLOT = 0x10dce290ee6a5ccb456adea9a31119a94bdce8f84b9abcd1d30b488166565d00;

    function _s() private pure returns (AccountStorage storage $) {
        assembly {
            $.slot := STORAGE_SLOT
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------------------------------------

    /// @notice One-time setup. `sig` is the EOA's signature over `Init(recoveryKey, recoveryDelay)`.
    /// @dev `recoveryKey == address(0)` disables recovery; `recoveryDelay` is then stored as given.
    function initialize(address recoveryKey, uint256 recoveryDelay, bytes calldata sig) external {
        AccountStorage storage $ = _s();
        if ($.initialized) revert AlreadyInitialized();
        if (recoveryKey != address(0) && recoveryDelay == 0) revert InvalidRecoveryDelay();

        bytes32 structHash = keccak256(abi.encode(INIT_TYPEHASH, recoveryKey, recoveryDelay));
        _requireSelfSig(_hashTypedData(structHash), sig);

        $.initialized = true;
        $.recoveryKey = recoveryKey;
        $.recoveryDelay = recoveryDelay;
        emit Initialized(recoveryKey, recoveryDelay);
    }

    // ---------------------------------------------------------------------------------------------
    // Relayed execution
    // ---------------------------------------------------------------------------------------------

    /// @notice Executes a call authorized by the EOA's signature over `Execute` at the current nonce.
    /// Anyone (typically a relayer) may submit it.
    function execute(address to, uint256 value, bytes calldata data, uint256 deadline, bytes calldata sig)
        external
        payable
        returns (bytes memory result)
    {
        AccountStorage storage $ = _s();
        if (!$.initialized) revert NotInitialized();
        if (block.timestamp > deadline) revert Expired();

        uint256 currentNonce = $.nonce;
        bytes32 structHash = keccak256(abi.encode(EXECUTE_TYPEHASH, to, value, keccak256(data), currentNonce, deadline));
        _requireSelfSig(_hashTypedData(structHash), sig);

        // Effects before interaction: the nonce is consumed before the external call.
        unchecked {
            $.nonce = currentNonce + 1;
        }
        emit Executed(currentNonce, to, value, data);

        result = _call(to, value, data);
    }

    // ---------------------------------------------------------------------------------------------
    // Recovery
    // ---------------------------------------------------------------------------------------------

    /// @notice Starts (or restarts) the recovery time lock. Only callable by the recovery key.
    function initiateRecovery() external {
        AccountStorage storage $ = _s();
        _requireRecoveryKey($);
        uint256 readyAt = block.timestamp + $.recoveryDelay;
        $.recoveryReadyAt = readyAt;
        emit RecoveryInitiated(readyAt);
    }

    /// @notice Cancels a pending or active recovery. `sig` is the EOA's signature over
    /// `CancelRecovery(nonce, deadline)` at the current nonce. Consumes the nonce.
    function cancelRecovery(uint256 deadline, bytes calldata sig) external {
        AccountStorage storage $ = _s();
        if (!$.initialized) revert NotInitialized();
        if (block.timestamp > deadline) revert Expired();

        uint256 currentNonce = $.nonce;
        bytes32 structHash = keccak256(abi.encode(CANCEL_RECOVERY_TYPEHASH, currentNonce, deadline));
        _requireSelfSig(_hashTypedData(structHash), sig);

        unchecked {
            $.nonce = currentNonce + 1;
        }
        $.recoveryReadyAt = 0;
        emit RecoveryCancelled(currentNonce);
    }

    /// @notice Executes a call as the account once the recovery time lock has elapsed.
    /// Recovery stays active after use; the dWallet can end it with `cancelRecovery`.
    function recoveryExecute(address to, uint256 value, bytes calldata data)
        external
        payable
        returns (bytes memory result)
    {
        AccountStorage storage $ = _s();
        _requireRecoveryKey($);
        uint256 readyAt = $.recoveryReadyAt;
        if (readyAt == 0 || block.timestamp < readyAt) revert RecoveryNotReady();

        emit RecoveryExecuted(to, value, data);
        result = _call(to, value, data);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function nonce() external view returns (uint256) {
        return _s().nonce;
    }

    function recoveryState()
        external
        view
        returns (address recoveryKey, uint256 recoveryDelay, uint256 recoveryReadyAt, bool initialized)
    {
        AccountStorage storage $ = _s();
        return ($.recoveryKey, $.recoveryDelay, $.recoveryReadyAt, $.initialized);
    }

    /// @notice EIP-712 domain separator for this account (computed dynamically, see contract notes).
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice Full EIP-712 digests, exposed for off-chain parity checks.
    function hashExecute(address to, uint256 value, bytes calldata data, uint256 nonce_, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedData(keccak256(abi.encode(EXECUTE_TYPEHASH, to, value, keccak256(data), nonce_, deadline)));
    }

    function hashInit(address recoveryKey, uint256 recoveryDelay) external view returns (bytes32) {
        return _hashTypedData(keccak256(abi.encode(INIT_TYPEHASH, recoveryKey, recoveryDelay)));
    }

    function hashCancelRecovery(uint256 nonce_, uint256 deadline) external view returns (bytes32) {
        return _hashTypedData(keccak256(abi.encode(CANCEL_RECOVERY_TYPEHASH, nonce_, deadline)));
    }

    // ---------------------------------------------------------------------------------------------
    // ERC-1271 / token receivers / ERC-165
    // ---------------------------------------------------------------------------------------------

    /// @notice ERC-1271: valid iff `sig` over the raw `hash` recovers to this account.
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        return _recover(hash, sig) == address(this) ? ERC1271_MAGIC : ERC1271_INVALID;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector; // 0x150b7a02
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector; // 0xf23a6e61
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector; // 0xbc197c81
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x150b7a02 // ERC-721 receiver
            || interfaceId == 0x4e2312e0 // ERC-1155 receiver
            || interfaceId == 0x1626ba7e; // ERC-1271
    }

    receive() external payable {}

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    function _requireSelfSig(bytes32 digest, bytes calldata sig) internal view {
        if (_recover(digest, sig) != address(this)) revert InvalidSignature();
    }

    function _requireRecoveryKey(AccountStorage storage $) internal view {
        address rk = $.recoveryKey;
        if (rk == address(0) || msg.sender != rk) revert NotRecoveryKey();
    }

    /// @dev Recovers a 65-byte r||s||v signature. v may be 27/28 or 0/1. Returns address(0) for any
    /// malformed input (wrong length, bad v, high s, or ecrecover failure); never reverts.
    function _recover(bytes32 digest, bytes calldata sig) internal view returns (address signer) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > HALF_N) return address(0);
        signer = ecrecover(digest, v, r, s);
        // ecrecover returns address(0) on failure; address(this) is never zero, so callers comparing
        // against address(this) reject it automatically.
    }

    function _call(address to, uint256 value, bytes calldata data) internal returns (bytes memory result) {
        bool ok;
        (ok, result) = to.call{value: value}(data);
        if (!ok) {
            if (result.length == 0) revert CallFailed();
            assembly {
                revert(add(result, 0x20), mload(result))
            }
        }
    }
}
