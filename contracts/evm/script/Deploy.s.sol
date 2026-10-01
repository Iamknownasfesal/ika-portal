// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IkaAccount} from "../src/IkaAccount.sol";

/// @notice Deploys the IkaAccount EIP-7702 delegate implementation.
/// forge script script/Deploy.s.sol:Deploy --rpc-url $RPC --private-key $PK --broadcast
contract Deploy is Script {
    function run() external returns (IkaAccount account) {
        vm.startBroadcast();
        account = new IkaAccount();
        vm.stopBroadcast();
        console2.log("IkaAccount deployed at:", address(account));
        console2.log("chainId:", block.chainid);
    }
}
