// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.28;

/// @notice Minimal ERC-20 for tests.
contract MockERC20 {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @notice Reverts in various ways to test revert bubbling.
contract Reverter {
    error Boom(uint256 code);

    function boom(uint256 code) external pure {
        revert Boom(code);
    }

    function message() external pure {
        revert("nope");
    }

    function empty() external pure {
        revert();
    }
}

/// @notice Records the last call it received.
contract Target {
    address public lastSender;
    uint256 public lastValue;
    bytes public lastData;

    function ping(uint256 x) external payable returns (uint256) {
        lastSender = msg.sender;
        lastValue = msg.value;
        lastData = msg.data;
        return x + 1;
    }
}

interface IExecute {
    function execute(address to, uint256 value, bytes calldata data, uint256 deadline, bytes calldata sig)
        external
        payable
        returns (bytes memory);
}

/// @notice When called, re-enters `execute` on the caller replaying a stored signature.
contract Reentrant {
    address public to;
    uint256 public value;
    bytes public data;
    uint256 public deadline;
    bytes public sig;

    function arm(address to_, uint256 value_, bytes calldata data_, uint256 deadline_, bytes calldata sig_) external {
        to = to_;
        value = value_;
        data = data_;
        deadline = deadline_;
        sig = sig_;
    }

    function attack() external {
        IExecute(msg.sender).execute(to, value, data, deadline, sig);
    }
}
