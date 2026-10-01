// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IkaAccount} from "../src/IkaAccount.sol";
import {MockERC20, Reverter, Target, Reentrant} from "./mocks/Mocks.sol";

/// @dev Independent EIP-712 implementation used to build digests in tests. It deliberately does not
/// call into IkaAccount so that the contract's hashing is checked against a second implementation.
library Eip712Ref {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant EXECUTE_TYPEHASH =
        keccak256("Execute(address to,uint256 value,bytes data,uint256 nonce,uint256 deadline)");
    bytes32 internal constant INIT_TYPEHASH = keccak256("Init(address recoveryKey,uint256 recoveryDelay)");
    bytes32 internal constant CANCEL_TYPEHASH = keccak256("CancelRecovery(uint256 nonce,uint256 deadline)");

    function domain(uint256 chainId, address account) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(DOMAIN_TYPEHASH, keccak256(bytes("IkaAccount")), keccak256(bytes("1")), chainId, account)
            );
    }

    function digest(uint256 chainId, address account, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes2(0x1901), domain(chainId, account), structHash));
    }

    function execute(
        uint256 chainId,
        address account,
        address to,
        uint256 value,
        bytes memory data,
        uint256 nonce,
        uint256 deadline
    ) internal pure returns (bytes32) {
        return digest(
            chainId, account, keccak256(abi.encode(EXECUTE_TYPEHASH, to, value, keccak256(data), nonce, deadline))
        );
    }

    function init(uint256 chainId, address account, address recoveryKey, uint256 recoveryDelay)
        internal
        pure
        returns (bytes32)
    {
        return digest(chainId, account, keccak256(abi.encode(INIT_TYPEHASH, recoveryKey, recoveryDelay)));
    }

    function cancel(uint256 chainId, address account, uint256 nonce, uint256 deadline) internal pure returns (bytes32) {
        return digest(chainId, account, keccak256(abi.encode(CANCEL_TYPEHASH, nonce, deadline)));
    }
}

contract IkaAccountTest is Test {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant DELAY = 3 days;

    IkaAccount internal impl;
    IkaAccount internal account; // the EOA, viewed through the delegate's ABI

    uint256 internal eoaPk = 0xA11CE;
    address internal eoa;
    uint256 internal recoveryPk = 0xB0B;
    address internal recoveryKey;
    uint256 internal otherPk = 0xBAD;
    address internal relayer = makeAddr("relayer");
    address internal alice = makeAddr("alice");

    MockERC20 internal token;
    Reverter internal reverter;
    Target internal target;

    function setUp() public {
        vm.warp(1_700_000_000);
        eoa = vm.addr(eoaPk);
        recoveryKey = vm.addr(recoveryPk);
        impl = new IkaAccount();
        token = new MockERC20();
        reverter = new Reverter();
        target = new Target();

        // EIP-7702: sign an authorization with the EOA key and attach it to the next call.
        Vm.SignedDelegation memory del = vm.signDelegation(address(impl), eoaPk);
        vm.attachDelegation(del);
        // The next call carries the authorization list; afterwards the EOA code is the designator.
        account = IkaAccount(payable(eoa));
        assertEq(account.nonce(), 0);
        assertEq(eoa.code, abi.encodePacked(hex"ef0100", address(impl)), "delegation designator");

        vm.deal(eoa, 10 ether);
        token.mint(eoa, 1_000e18);
    }

    // -------------------------------------------------------------------------------------------
    // helpers
    // -------------------------------------------------------------------------------------------

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _initSig(uint256 pk, address rk, uint256 delay) internal view returns (bytes memory) {
        return _sign(pk, Eip712Ref.init(block.chainid, eoa, rk, delay));
    }

    function _init() internal {
        vm.prank(relayer);
        account.initialize(recoveryKey, DELAY, _initSig(eoaPk, recoveryKey, DELAY));
    }

    function _execSig(uint256 pk, address to, uint256 value, bytes memory data, uint256 n, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(pk, Eip712Ref.execute(block.chainid, eoa, to, value, data, n, deadline));
    }

    function _exec(address to, uint256 value, bytes memory data) internal returns (bytes memory) {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _execSig(eoaPk, to, value, data, account.nonce(), deadline);
        vm.prank(relayer);
        return account.execute(to, value, data, deadline, sig);
    }

    function _cancelSig(uint256 pk, uint256 n, uint256 deadline) internal view returns (bytes memory) {
        return _sign(pk, Eip712Ref.cancel(block.chainid, eoa, n, deadline));
    }

    // -------------------------------------------------------------------------------------------
    // storage / hashing
    // -------------------------------------------------------------------------------------------

    function test_storageSlotConstant() public view {
        bytes32 expected =
            keccak256(abi.encode(uint256(keccak256("ika.account.storage.v1")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(impl.STORAGE_SLOT(), expected);
        assertEq(expected, 0x10dce290ee6a5ccb456adea9a31119a94bdce8f84b9abcd1d30b488166565d00);
    }

    function test_storageLayoutInNamespace() public {
        _init();
        uint256 base = uint256(impl.STORAGE_SLOT());
        // slot 0: bool initialized (byte 0) | address recoveryKey (bytes 1..20)
        bytes32 w0 = vm.load(eoa, bytes32(base));
        assertEq(uint8(uint256(w0)), 1);
        assertEq(address(uint160(uint256(w0) >> 8)), recoveryKey);
        assertEq(uint256(vm.load(eoa, bytes32(base + 1))), DELAY);
        assertEq(uint256(vm.load(eoa, bytes32(base + 2))), 0); // nonce
        // Nothing written to slot 0 of the EOA.
        assertEq(vm.load(eoa, bytes32(0)), bytes32(0));
        // Implementation's own storage untouched.
        assertEq(vm.load(address(impl), bytes32(base)), bytes32(0));
    }

    function test_typehashesAndDigestsMatchReference() public view {
        assertEq(impl.EXECUTE_TYPEHASH(), Eip712Ref.EXECUTE_TYPEHASH);
        assertEq(impl.INIT_TYPEHASH(), Eip712Ref.INIT_TYPEHASH);
        assertEq(impl.CANCEL_RECOVERY_TYPEHASH(), Eip712Ref.CANCEL_TYPEHASH);
        assertEq(account.domainSeparator(), Eip712Ref.domain(block.chainid, eoa));
        assertEq(
            account.hashExecute(alice, 1, hex"abcd", 7, 99),
            Eip712Ref.execute(block.chainid, eoa, alice, 1, hex"abcd", 7, 99)
        );
        assertEq(account.hashInit(recoveryKey, DELAY), Eip712Ref.init(block.chainid, eoa, recoveryKey, DELAY));
        assertEq(account.hashCancelRecovery(3, 4), Eip712Ref.cancel(block.chainid, eoa, 3, 4));
    }

    function test_domainSeparatorIsDynamic() public {
        bytes32 d1 = account.domainSeparator();
        assertTrue(d1 != impl.domainSeparator(), "differs per address");
        vm.chainId(8453);
        assertEq(account.domainSeparator(), Eip712Ref.domain(8453, eoa));
        assertTrue(account.domainSeparator() != d1, "differs per chain");
    }

    /// @dev Known vectors for cross-component parity (viem hashTypedData, Solana program).
    function test_knownVectors() public {
        address fixedEoa = 0x1111111111111111111111111111111111111111;
        vm.chainId(31337);
        vm.etch(fixedEoa, abi.encodePacked(hex"ef0100", address(impl)));
        IkaAccount a = IkaAccount(payable(fixedEoa));

        bytes32 dom = Eip712Ref.domain(31337, fixedEoa);
        bytes32 exec = Eip712Ref.execute(
            31337, fixedEoa, 0x2222222222222222222222222222222222222222, 1 ether, "", 0, 1_700_000_000
        );
        bytes32 init = Eip712Ref.init(31337, fixedEoa, 0x3333333333333333333333333333333333333333, 259200);
        bytes32 cancel = Eip712Ref.cancel(31337, fixedEoa, 5, 1_700_000_000);

        assertEq(a.domainSeparator(), dom);
        assertEq(a.hashExecute(0x2222222222222222222222222222222222222222, 1 ether, "", 0, 1_700_000_000), exec);
        assertEq(a.hashInit(0x3333333333333333333333333333333333333333, 259200), init);
        assertEq(a.hashCancelRecovery(5, 1_700_000_000), cancel);

        console2.log("domainSeparator(0x1111..., 31337):");
        console2.logBytes32(dom);
        console2.log("Execute(to=0x2222..., value=1 ether, data=0x, nonce=0, deadline=1700000000) digest:");
        console2.logBytes32(exec);
        console2.log("Init(recoveryKey=0x3333..., recoveryDelay=259200) digest:");
        console2.logBytes32(init);
        console2.log("CancelRecovery(nonce=5, deadline=1700000000) digest:");
        console2.logBytes32(cancel);

        // Pinned; independently reproduced with `cast keccak`/`cast abi-encode` (see README).
        assertEq(dom, 0x92e4c6e5bbda3c3ddbe213605c97bef4e00bdb62d2bc3dfb79e20f37e5808f99);
        assertEq(exec, 0x1f00b6a1ffc9240c0b8595df34ee26502762a951ea2e6c257bb01f551c65249e);
        assertEq(init, 0x503b07cf428298c95c086409b5f51c4938437ed7a4a4a4da3bd3ea9e2094c99b);
        assertEq(cancel, 0xcb0d63fd68c7873cdfe141c7164be121db356b5f8364d5ed4fccf5561f22e1b2);
    }

    // -------------------------------------------------------------------------------------------
    // initialize
    // -------------------------------------------------------------------------------------------

    function test_initialize() public {
        vm.expectEmit(true, false, false, true, eoa);
        emit IkaAccount.Initialized(recoveryKey, DELAY);
        _init();
        (address rk, uint256 d, uint256 readyAt, bool inited) = account.recoveryState();
        assertEq(rk, recoveryKey);
        assertEq(d, DELAY);
        assertEq(readyAt, 0);
        assertTrue(inited);
        assertEq(account.nonce(), 0);
    }

    function test_initialize_zeroRecoveryKey() public {
        account.initialize(address(0), 0, _initSig(eoaPk, address(0), 0));
        (address rk,,, bool inited) = account.recoveryState();
        assertEq(rk, address(0));
        assertTrue(inited);
        vm.prank(address(0));
        vm.expectRevert(IkaAccount.NotRecoveryKey.selector);
        account.initiateRecovery();
    }

    function test_initialize_zeroRecoveryKeyStoresDelay() public {
        account.initialize(address(0), 123, _initSig(eoaPk, address(0), 123));
        (, uint256 d,,) = account.recoveryState();
        assertEq(d, 123);
    }

    function test_initialize_revertsZeroDelayWithRecoveryKey() public {
        bytes memory sig = _initSig(eoaPk, recoveryKey, 0);
        vm.expectRevert(IkaAccount.InvalidRecoveryDelay.selector);
        account.initialize(recoveryKey, 0, sig);
    }

    function test_initialize_revertsTwice() public {
        _init();
        bytes memory sig = _initSig(eoaPk, alice, 1);
        vm.expectRevert(IkaAccount.AlreadyInitialized.selector);
        account.initialize(alice, 1, sig);
        // Replaying the original signature is also blocked.
        bytes memory orig = _initSig(eoaPk, recoveryKey, DELAY);
        vm.expectRevert(IkaAccount.AlreadyInitialized.selector);
        account.initialize(recoveryKey, DELAY, orig);
    }

    function test_initialize_revertsWrongSigner() public {
        bytes memory sig = _initSig(otherPk, recoveryKey, DELAY);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.initialize(recoveryKey, DELAY, sig);
    }

    function test_initialize_revertsTamperedParams() public {
        // Front-runner swaps in their own recovery key while reusing the EOA's signature.
        bytes memory sig = _initSig(eoaPk, recoveryKey, DELAY);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.initialize(alice, DELAY, sig);
    }

    function test_initialize_sigBoundToAccount() public {
        // A signature for another EOA's Init cannot initialize this EOA.
        address other = vm.addr(otherPk);
        vm.signAndAttachDelegation(address(impl), otherPk);
        IkaAccount otherAcct = IkaAccount(payable(other));
        otherAcct.nonce();
        bytes memory sigForOther = _sign(otherPk, Eip712Ref.init(block.chainid, other, recoveryKey, DELAY));
        otherAcct.initialize(recoveryKey, DELAY, sigForOther);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.initialize(recoveryKey, DELAY, sigForOther);
    }

    function test_implementationCannotBeInitializedByEoaSig() public {
        bytes memory sig = _initSig(eoaPk, recoveryKey, DELAY); // domain bound to eoa
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        impl.initialize(recoveryKey, DELAY, sig);
    }

    // -------------------------------------------------------------------------------------------
    // execute
    // -------------------------------------------------------------------------------------------

    function test_execute_revertsNotInitialized() public {
        bytes memory sig = _execSig(eoaPk, alice, 1, "", 0, block.timestamp);
        vm.expectRevert(IkaAccount.NotInitialized.selector);
        account.execute(alice, 1, "", block.timestamp, sig);
    }

    function test_execute_ethTransfer() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _execSig(eoaPk, alice, 1 ether, "", 0, deadline);
        vm.expectEmit(true, true, false, true, eoa);
        emit IkaAccount.Executed(0, alice, 1 ether, "");
        vm.prank(relayer);
        account.execute(alice, 1 ether, "", deadline, sig);
        assertEq(alice.balance, 1 ether);
        assertEq(eoa.balance, 9 ether);
        assertEq(account.nonce(), 1);
        assertEq(relayer.balance, 0, "relayer pays only gas");
    }

    function test_execute_erc20Transfer() public {
        _init();
        _exec(address(token), 0, abi.encodeCall(MockERC20.transfer, (alice, 250e18)));
        assertEq(token.balanceOf(alice), 250e18);
        assertEq(token.balanceOf(eoa), 750e18);
        assertEq(account.nonce(), 1);
    }

    function test_execute_returnsResultAndMsgSenderIsEoa() public {
        _init();
        bytes memory ret = _exec(address(target), 0.5 ether, abi.encodeCall(Target.ping, (41)));
        assertEq(abi.decode(ret, (uint256)), 42);
        assertEq(target.lastSender(), eoa);
        assertEq(target.lastValue(), 0.5 ether);
    }

    function test_execute_acceptsVZeroOne() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(eoaPk, Eip712Ref.execute(block.chainid, eoa, alice, 1, "", 0, deadline));
        account.execute(alice, 1, "", deadline, abi.encodePacked(r, s, v - 27));
        assertEq(account.nonce(), 1);
    }

    function test_execute_revertsWrongSigner() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _execSig(otherPk, alice, 1 ether, "", 0, deadline);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 1 ether, "", deadline, sig);
    }

    function test_execute_revertsRecoveryKeySigner() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _execSig(recoveryPk, alice, 1 ether, "", 0, deadline);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 1 ether, "", deadline, sig);
    }

    function test_execute_revertsTamperedParams() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _execSig(eoaPk, alice, 1 ether, "", 0, deadline);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 2 ether, "", deadline, sig);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(relayer, 1 ether, "", deadline, sig);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 1 ether, hex"00", deadline, sig);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 1 ether, "", deadline + 1, sig);
    }

    function test_execute_revertsWrongChain() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _execSig(eoaPk, alice, 1 ether, "", 0, deadline);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 1 ether, "", deadline, sig);
    }

    function test_execute_revertsMalformedLength() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _execSig(eoaPk, alice, 1, "", 0, deadline);
        bytes memory short = new bytes(64);
        for (uint256 i; i < 64; ++i) {
            short[i] = sig[i];
        }
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 1, "", deadline, short);

        bytes memory long = abi.encodePacked(sig, bytes1(0));
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 1, "", deadline, long);

        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 1, "", deadline, "");
    }

    function test_execute_revertsHighS() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes32 digest = Eip712Ref.execute(block.chainid, eoa, alice, 1, "", 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(eoaPk, digest);
        // Malleated twin: (r, n - s, v flipped) is also a valid ECDSA signature for the same key.
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, flippedV, r, highS), eoa, "twin is valid for raw ecrecover");
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 1, "", deadline, abi.encodePacked(r, highS, flippedV));
        // Low-s original works.
        account.execute(alice, 1, "", deadline, abi.encodePacked(r, s, v));
    }

    function test_execute_revertsBadV() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        (, bytes32 r, bytes32 s) = vm.sign(eoaPk, Eip712Ref.execute(block.chainid, eoa, alice, 1, "", 0, deadline));
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 1, "", deadline, abi.encodePacked(r, s, uint8(29)));
    }

    function test_execute_revertsZeroRecovery() public {
        _init();
        // r = 0 makes ecrecover return address(0).
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 1, "", block.timestamp, abi.encodePacked(bytes32(0), bytes32(uint256(1)), uint8(27)));
    }

    function test_execute_revertsReplay() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _execSig(eoaPk, alice, 1 ether, "", 0, deadline);
        account.execute(alice, 1 ether, "", deadline, sig);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 1 ether, "", deadline, sig);
        assertEq(alice.balance, 1 ether);
    }

    function test_execute_revertsFutureNonce() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _execSig(eoaPk, alice, 1 ether, "", 1, deadline);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 1 ether, "", deadline, sig);
    }

    function test_execute_deadline() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _execSig(eoaPk, alice, 1, "", 0, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(IkaAccount.Expired.selector);
        account.execute(alice, 1, "", deadline, sig);
        vm.warp(deadline); // inclusive
        account.execute(alice, 1, "", deadline, sig);
        assertEq(alice.balance, 1);
    }

    function test_execute_bubblesCustomError() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory data = abi.encodeCall(Reverter.boom, (7));
        bytes memory sig = _execSig(eoaPk, address(reverter), 0, data, 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(Reverter.Boom.selector, 7));
        account.execute(address(reverter), 0, data, deadline, sig);
        assertEq(account.nonce(), 0, "nonce rolled back with the revert");
    }

    function test_execute_bubblesStringRevert() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory data = abi.encodeCall(Reverter.message, ());
        bytes memory sig = _execSig(eoaPk, address(reverter), 0, data, 0, deadline);
        vm.expectRevert(bytes("nope"));
        account.execute(address(reverter), 0, data, deadline, sig);
    }

    function test_execute_emptyRevertIsCallFailed() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory data = abi.encodeCall(Reverter.empty, ());
        bytes memory sig = _execSig(eoaPk, address(reverter), 0, data, 0, deadline);
        vm.expectRevert(IkaAccount.CallFailed.selector);
        account.execute(address(reverter), 0, data, deadline, sig);
    }

    function test_execute_erc20InsufficientBubbles() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory data = abi.encodeCall(MockERC20.transfer, (alice, 10_000e18));
        bytes memory sig = _execSig(eoaPk, address(token), 0, data, 0, deadline);
        vm.expectRevert(MockERC20.InsufficientBalance.selector);
        account.execute(address(token), 0, data, deadline, sig);
    }

    function test_execute_reentrancyCannotReplay() public {
        _init();
        Reentrant attacker = new Reentrant();
        uint256 deadline = block.timestamp + 60;
        bytes memory data = abi.encodeCall(Reentrant.attack, ());
        bytes memory sig = _execSig(eoaPk, address(attacker), 0, data, 0, deadline);
        // The attacker re-enters execute with the very same signature; nonce is already 1.
        attacker.arm(address(attacker), 0, data, deadline, sig);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(address(attacker), 0, data, deadline, sig);
        assertEq(account.nonce(), 0);
    }

    function test_execute_reentrantNextNonceAllowed() public {
        // A re-entrant call with a *fresh* signature for nonce+1 is simply another authorized action.
        _init();
        Reentrant attacker = new Reentrant();
        uint256 deadline = block.timestamp + 60;
        bytes memory innerSig = _execSig(eoaPk, alice, 1 ether, "", 1, deadline);
        attacker.arm(alice, 1 ether, "", deadline, innerSig);
        bytes memory data = abi.encodeCall(Reentrant.attack, ());
        bytes memory sig = _execSig(eoaPk, address(attacker), 0, data, 0, deadline);
        account.execute(address(attacker), 0, data, deadline, sig);
        assertEq(account.nonce(), 2);
        assertEq(alice.balance, 1 ether);
    }

    function test_eoaCanStillSendRawTx() public {
        // Accepted by design: the dWallet key itself can transact directly.
        _init();
        vm.prank(eoa);
        (bool ok,) = alice.call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(alice.balance, 1 ether);
    }

    // -------------------------------------------------------------------------------------------
    // recovery
    // -------------------------------------------------------------------------------------------

    function test_recovery_fullFlow() public {
        _init();
        vm.expectEmit(false, false, false, true, eoa);
        emit IkaAccount.RecoveryInitiated(block.timestamp + DELAY);
        vm.prank(recoveryKey);
        account.initiateRecovery();
        (,, uint256 readyAt,) = account.recoveryState();
        assertEq(readyAt, block.timestamp + DELAY);

        vm.warp(readyAt);
        vm.expectEmit(true, false, false, true, eoa);
        emit IkaAccount.RecoveryExecuted(alice, 2 ether, "");
        vm.prank(recoveryKey);
        account.recoveryExecute(alice, 2 ether, "");
        assertEq(alice.balance, 2 ether);

        // Recovery stays active.
        vm.prank(recoveryKey);
        account.recoveryExecute(address(token), 0, abi.encodeCall(MockERC20.transfer, (alice, 1e18)));
        assertEq(token.balanceOf(alice), 1e18);
        (,, readyAt,) = account.recoveryState();
        assertTrue(readyAt != 0);
    }

    function test_recovery_beforeDelayFails() public {
        _init();
        vm.prank(recoveryKey);
        account.initiateRecovery();
        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(recoveryKey);
        vm.expectRevert(IkaAccount.RecoveryNotReady.selector);
        account.recoveryExecute(alice, 1, "");
    }

    function test_recovery_notInitiatedFails() public {
        _init();
        vm.warp(block.timestamp + 365 days);
        vm.prank(recoveryKey);
        vm.expectRevert(IkaAccount.RecoveryNotReady.selector);
        account.recoveryExecute(alice, 1, "");
    }

    function test_recovery_nonRecoveryKeyCannotInitiate() public {
        _init();
        vm.prank(alice);
        vm.expectRevert(IkaAccount.NotRecoveryKey.selector);
        account.initiateRecovery();
        vm.prank(eoa);
        vm.expectRevert(IkaAccount.NotRecoveryKey.selector);
        account.initiateRecovery();
    }

    function test_recovery_nonRecoveryKeyCannotExecute() public {
        _init();
        vm.prank(recoveryKey);
        account.initiateRecovery();
        vm.warp(block.timestamp + DELAY);
        vm.prank(alice);
        vm.expectRevert(IkaAccount.NotRecoveryKey.selector);
        account.recoveryExecute(alice, 1, "");
    }

    function test_recovery_notInitializedFails() public {
        vm.prank(address(0));
        vm.expectRevert(IkaAccount.NotRecoveryKey.selector);
        account.initiateRecovery();
    }

    function test_recoveryExecute_bubblesRevert() public {
        _init();
        vm.prank(recoveryKey);
        account.initiateRecovery();
        vm.warp(block.timestamp + DELAY);
        vm.prank(recoveryKey);
        vm.expectRevert(abi.encodeWithSelector(Reverter.Boom.selector, 9));
        account.recoveryExecute(address(reverter), 0, abi.encodeCall(Reverter.boom, (9)));
    }

    function test_cancelRecovery() public {
        _init();
        vm.prank(recoveryKey);
        account.initiateRecovery();

        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _cancelSig(eoaPk, 0, deadline);
        vm.expectEmit(true, false, false, true, eoa);
        emit IkaAccount.RecoveryCancelled(0);
        vm.prank(relayer);
        account.cancelRecovery(deadline, sig);

        (,, uint256 readyAt,) = account.recoveryState();
        assertEq(readyAt, 0);
        assertEq(account.nonce(), 1);

        vm.warp(block.timestamp + DELAY);
        vm.prank(recoveryKey);
        vm.expectRevert(IkaAccount.RecoveryNotReady.selector);
        account.recoveryExecute(alice, 1, "");

        // Replay of the cancel signature fails.
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.cancelRecovery(deadline + DELAY, sig);
    }

    function test_cancelRecovery_afterReadyStopsRecovery() public {
        _init();
        vm.prank(recoveryKey);
        account.initiateRecovery();
        vm.warp(block.timestamp + DELAY);
        vm.prank(recoveryKey);
        account.recoveryExecute(alice, 1, "");

        uint256 deadline = block.timestamp + 60;
        account.cancelRecovery(deadline, _cancelSig(eoaPk, 0, deadline));
        vm.prank(recoveryKey);
        vm.expectRevert(IkaAccount.RecoveryNotReady.selector);
        account.recoveryExecute(alice, 1, "");
    }

    function test_cancelRecovery_invalidatesPendingExecute() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory execSig = _execSig(eoaPk, alice, 1 ether, "", 0, deadline);
        account.cancelRecovery(deadline, _cancelSig(eoaPk, 0, deadline));
        assertEq(account.nonce(), 1);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 1 ether, "", deadline, execSig);
    }

    function test_cancelRecovery_revertsWrongSigner() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _cancelSig(recoveryPk, 0, deadline);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.cancelRecovery(deadline, sig);
    }

    function test_cancelRecovery_revertsExpired() public {
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _cancelSig(eoaPk, 0, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(IkaAccount.Expired.selector);
        account.cancelRecovery(deadline, sig);
    }

    function test_cancelRecovery_revertsNotInitialized() public {
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _cancelSig(eoaPk, 0, deadline);
        vm.expectRevert(IkaAccount.NotInitialized.selector);
        account.cancelRecovery(deadline, sig);
    }

    function test_cancelRecovery_crossTypeSigRejected() public {
        // An Execute signature must not be usable as a CancelRecovery signature and vice versa.
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory execSig = _execSig(eoaPk, alice, 0, "", 0, deadline);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.cancelRecovery(deadline, execSig);
    }

    // -------------------------------------------------------------------------------------------
    // receivers / 1271
    // -------------------------------------------------------------------------------------------

    function test_receiveEth() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = eoa.call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(eoa.balance, 11 ether);
    }

    function test_tokenReceivers() public view {
        assertEq(account.onERC721Received(alice, alice, 1, ""), bytes4(0x150b7a02));
        assertEq(account.onERC1155Received(alice, alice, 1, 1, ""), bytes4(0xf23a6e61));
        assertEq(
            account.onERC1155BatchReceived(alice, alice, new uint256[](0), new uint256[](0), ""), bytes4(0xbc197c81)
        );
        assertTrue(account.supportsInterface(0x01ffc9a7));
        assertTrue(account.supportsInterface(0x150b7a02));
        assertTrue(account.supportsInterface(0x4e2312e0));
        assertTrue(account.supportsInterface(0x1626ba7e));
        assertFalse(account.supportsInterface(0xffffffff));
    }

    function test_isValidSignature() public view {
        bytes32 h = keccak256("hello");
        assertEq(account.isValidSignature(h, _sign(eoaPk, h)), bytes4(0x1626ba7e));
        assertEq(account.isValidSignature(h, _sign(otherPk, h)), bytes4(0xffffffff));
        assertEq(account.isValidSignature(h, hex"1234"), bytes4(0xffffffff));
    }

    // -------------------------------------------------------------------------------------------
    // fuzz
    // -------------------------------------------------------------------------------------------

    function testFuzz_execute_digestParity(address to, uint256 value, bytes calldata data, uint256 n, uint256 dl)
        public
        view
    {
        assertEq(
            account.hashExecute(to, value, data, n, dl), Eip712Ref.execute(block.chainid, eoa, to, value, data, n, dl)
        );
    }

    function testFuzz_execute_randomSignerRejected(uint256 pk) public {
        pk = bound(pk, 1, SECP256K1_N - 1);
        vm.assume(pk != eoaPk);
        _init();
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _execSig(pk, alice, 1, "", 0, deadline);
        vm.expectRevert(IkaAccount.InvalidSignature.selector);
        account.execute(alice, 1, "", deadline, sig);
    }
}
