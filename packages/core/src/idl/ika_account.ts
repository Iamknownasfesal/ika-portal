/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/ika_account.json`.
 */
export type IkaAccountIdl = {
  "address": "Dx7P74pmeMqgPG4iF3VpL5aZ6TZTMiPzcMULnpu2hyje",
  "metadata": {
    "name": "ikaAccount",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Ika Portal policy program: Solana-controlled BTC/EVM accounts via Ika dWallets"
  },
  "instructions": [
    {
      "name": "applyPolicy",
      "discriminator": [
        255,
        235,
        232,
        54,
        183,
        33,
        131,
        224
      ],
      "accounts": [
        {
          "name": "account",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "approveIntent",
      "discriminator": [
        213,
        94,
        174,
        15,
        36,
        50,
        145,
        18
      ],
      "accounts": [
        {
          "name": "account",
          "writable": true,
          "relations": [
            "intent"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "intent",
          "writable": true
        },
        {
          "name": "dwallet"
        },
        {
          "name": "coordinator"
        },
        {
          "name": "cpiAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  105,
                  107,
                  97,
                  95,
                  99,
                  112,
                  105,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "callerProgram",
          "address": "Dx7P74pmeMqgPG4iF3VpL5aZ6TZTMiPzcMULnpu2hyje"
        },
        {
          "name": "dwalletProgram"
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "cancelIntent",
      "discriminator": [
        67,
        73,
        238,
        244,
        208,
        89,
        225,
        59
      ],
      "accounts": [
        {
          "name": "account",
          "writable": true,
          "relations": [
            "intent"
          ]
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "account"
          ]
        },
        {
          "name": "intent",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "cancelPolicy",
      "discriminator": [
        244,
        58,
        241,
        221,
        106,
        151,
        94,
        116
      ],
      "accounts": [
        {
          "name": "account",
          "writable": true
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "account"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "createAccount",
      "discriminator": [
        99,
        20,
        130,
        119,
        196,
        235,
        131,
        149
      ],
      "accounts": [
        {
          "name": "account",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "args.index"
              }
            ]
          }
        },
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createAccountArgs"
            }
          }
        }
      ]
    },
    {
      "name": "initializeConfig",
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "configArgs"
            }
          }
        }
      ]
    },
    {
      "name": "previewDigests",
      "discriminator": [
        102,
        22,
        104,
        68,
        150,
        96,
        221,
        94
      ],
      "accounts": [
        {
          "name": "account"
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "intentParams"
            }
          }
        },
        {
          "name": "evmNonce",
          "type": "u64"
        }
      ],
      "returns": {
        "vec": {
          "defined": {
            "name": "digestPreview"
          }
        }
      }
    },
    {
      "name": "proposeIntent",
      "discriminator": [
        235,
        187,
        3,
        3,
        160,
        187,
        162,
        226
      ],
      "accounts": [
        {
          "name": "account",
          "writable": true
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "account"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "intent",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  116,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "account"
              },
              {
                "kind": "account",
                "path": "account.intentNonce",
                "account": "ikaAccount"
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "intentParams"
            }
          }
        }
      ]
    },
    {
      "name": "proposePolicy",
      "discriminator": [
        76,
        109,
        252,
        233,
        201,
        68,
        11,
        165
      ],
      "accounts": [
        {
          "name": "account",
          "writable": true
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "account"
          ]
        }
      ],
      "args": [
        {
          "name": "next",
          "type": {
            "defined": {
              "name": "policy"
            }
          }
        }
      ]
    },
    {
      "name": "registerDwallet",
      "discriminator": [
        186,
        119,
        139,
        52,
        93,
        184,
        231,
        1
      ],
      "accounts": [
        {
          "name": "account",
          "writable": true
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "account"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "dwallet"
        },
        {
          "name": "cpiAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  105,
                  107,
                  97,
                  95,
                  99,
                  112,
                  105,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "claim",
          "docs": [
            "Prevents the same dWallet from being registered to a second account."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  108,
                  97,
                  105,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "dwallet"
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "role",
          "type": {
            "defined": {
              "name": "dWalletRole"
            }
          }
        },
        {
          "name": "evmPubkeyY",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "setEvmNonce",
      "discriminator": [
        30,
        22,
        225,
        11,
        160,
        107,
        106,
        118
      ],
      "accounts": [
        {
          "name": "account",
          "writable": true
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "account"
          ]
        }
      ],
      "args": [
        {
          "name": "chainId",
          "type": "u64"
        },
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "updateConfig",
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "configArgs"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "dWalletClaim",
      "discriminator": [
        162,
        13,
        167,
        198,
        149,
        5,
        148,
        157
      ]
    },
    {
      "name": "ikaAccount",
      "discriminator": [
        24,
        53,
        243,
        250,
        255,
        66,
        186,
        171
      ]
    },
    {
      "name": "intent",
      "discriminator": [
        247,
        162,
        35,
        165,
        254,
        111,
        129,
        109
      ]
    }
  ],
  "events": [
    {
      "name": "accountCreated",
      "discriminator": [
        70,
        39,
        6,
        173,
        118,
        198,
        190,
        91
      ]
    },
    {
      "name": "dWalletRegistered",
      "discriminator": [
        215,
        251,
        208,
        184,
        15,
        213,
        181,
        128
      ]
    },
    {
      "name": "intentApproved",
      "discriminator": [
        144,
        44,
        75,
        93,
        58,
        151,
        160,
        172
      ]
    },
    {
      "name": "intentCancelled",
      "discriminator": [
        39,
        174,
        74,
        165,
        39,
        101,
        119,
        29
      ]
    },
    {
      "name": "intentProposed",
      "discriminator": [
        249,
        245,
        19,
        13,
        26,
        73,
        164,
        131
      ]
    },
    {
      "name": "policyApplied",
      "discriminator": [
        224,
        50,
        201,
        229,
        63,
        157,
        248,
        239
      ]
    },
    {
      "name": "policyProposed",
      "discriminator": [
        218,
        131,
        42,
        156,
        255,
        118,
        219,
        223
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "limitExceeded",
      "msg": "Spending limit for this chain/asset window exceeded"
    },
    {
      "code": 6001,
      "name": "recipientNotAllowed",
      "msg": "Recipient is not in the allowlist"
    },
    {
      "code": 6002,
      "name": "swapsDisabled",
      "msg": "Swaps are disabled by policy"
    },
    {
      "code": 6003,
      "name": "swapLimitExceeded",
      "msg": "Swap limit for this chain/asset window exceeded"
    },
    {
      "code": 6004,
      "name": "feeTooHigh",
      "msg": "Fee exceeds the policy cap"
    },
    {
      "code": 6005,
      "name": "unknownChain",
      "msg": "Chain is not configured"
    },
    {
      "code": 6006,
      "name": "tooManyInputs",
      "msg": "Too many Bitcoin inputs"
    },
    {
      "code": 6007,
      "name": "unknownAsset",
      "msg": "Asset is not configured for this chain"
    },
    {
      "code": 6008,
      "name": "invalidPolicy",
      "msg": "Invalid policy"
    },
    {
      "code": 6009,
      "name": "invalidRecovery",
      "msg": "Recovery parameters do not match the account mode"
    },
    {
      "code": 6010,
      "name": "pdaOwnerRequiresPublicShare",
      "msg": "A PDA owner must use userShare = public"
    },
    {
      "code": 6011,
      "name": "invalidDWallet",
      "msg": "Account is not owned by the configured dWallet program or has a bad layout"
    },
    {
      "code": 6012,
      "name": "dWalletNotActive",
      "msg": "dWallet is not active"
    },
    {
      "code": 6013,
      "name": "wrongDWalletAuthority",
      "msg": "dWallet authority is not this program's CPI authority (run transfer_ownership first)"
    },
    {
      "code": 6014,
      "name": "wrongCurve",
      "msg": "dWallet curve must be secp256k1"
    },
    {
      "code": 6015,
      "name": "invalidRole",
      "msg": "dWallet role is invalid for this mode or already registered"
    },
    {
      "code": 6016,
      "name": "accountNotReady",
      "msg": "Account has no dWallet registered for this chain"
    },
    {
      "code": 6017,
      "name": "invalidIntentParams",
      "msg": "Invalid intent parameters"
    },
    {
      "code": 6018,
      "name": "invalidAddress",
      "msg": "Invalid address"
    },
    {
      "code": 6019,
      "name": "insufficientInputs",
      "msg": "Bitcoin inputs do not cover amount + fee"
    },
    {
      "code": 6020,
      "name": "evmNotDelegated",
      "msg": "Account is not set up for delegated EVM execution on this chain"
    },
    {
      "code": 6021,
      "name": "recoveryNotConfigured",
      "msg": "Recovery is not configured for this account"
    },
    {
      "code": 6022,
      "name": "deadlineExpired",
      "msg": "Deadline has passed"
    },
    {
      "code": 6023,
      "name": "invalidPoint",
      "msg": "Invalid secp256k1 point"
    },
    {
      "code": 6024,
      "name": "digestError",
      "msg": "Digest serialization failed"
    },
    {
      "code": 6025,
      "name": "intentNotProposed",
      "msg": "Intent is not in the proposed state"
    },
    {
      "code": 6026,
      "name": "notExecutableYet",
      "msg": "Intent is not executable yet (delay)"
    },
    {
      "code": 6027,
      "name": "noPendingPolicy",
      "msg": "No pending policy"
    },
    {
      "code": 6028,
      "name": "policyChangeNotReady",
      "msg": "Policy change delay has not elapsed"
    },
    {
      "code": 6029,
      "name": "invalidMessageApproval",
      "msg": "MessageApproval account does not match the computed PDA"
    },
    {
      "code": 6030,
      "name": "wrongApprovalCount",
      "msg": "Wrong number of MessageApproval accounts"
    },
    {
      "code": 6031,
      "name": "wrongDWallet",
      "msg": "Wrong dWallet account for this chain"
    },
    {
      "code": 6032,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "accountCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "index",
            "type": "u16"
          },
          {
            "name": "mode",
            "type": {
              "defined": {
                "name": "mode"
              }
            }
          },
          {
            "name": "userShare",
            "type": {
              "defined": {
                "name": "userShare"
              }
            }
          }
        ]
      }
    },
    {
      "name": "allowEntry",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "chain",
            "type": {
              "defined": {
                "name": "chain"
              }
            }
          },
          {
            "name": "address",
            "docs": [
              "EVM: 20-byte address. Bitcoin: the output scriptPubKey."
            ],
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "approval",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "messageDigest",
            "docs": [
              "keccak256(preimage): the Ika `MessageApproval` key."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "finalDigest",
            "docs": [
              "The 32-byte hash that is actually signed (EIP-712 / tx hash / BIP143 sighash)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "scheme",
            "type": "u16"
          },
          {
            "name": "messageApproval",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "btcInput",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "txid",
            "docs": [
              "Internal byte order (reverse of the displayed txid)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "vout",
            "type": "u32"
          },
          {
            "name": "value",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "btcNetwork",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "mainnet"
          },
          {
            "name": "testnet"
          },
          {
            "name": "regtest"
          }
        ]
      }
    },
    {
      "name": "btcParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "inputs",
            "type": {
              "vec": {
                "defined": {
                  "name": "btcInput"
                }
              }
            }
          },
          {
            "name": "fee",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "chain",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "bitcoin"
          },
          {
            "name": "ethereum"
          },
          {
            "name": "base"
          }
        ]
      }
    },
    {
      "name": "charge",
      "docs": [
        "Spend-window usage recorded at propose time so `cancel_intent` can release it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "index",
            "type": "u8"
          },
          {
            "name": "windowStart",
            "type": "i64"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "dwalletProgram",
            "docs": [
              "Ika dWallet program (or `mock_dwallet` locally). Switching is config-only."
            ],
            "type": "pubkey"
          },
          {
            "name": "btcNetwork",
            "type": {
              "defined": {
                "name": "btcNetwork"
              }
            }
          },
          {
            "name": "maxBtcInputs",
            "type": "u8"
          },
          {
            "name": "evmChains",
            "type": {
              "vec": {
                "defined": {
                  "name": "evmChainConfig"
                }
              }
            }
          },
          {
            "name": "tokens",
            "type": {
              "vec": {
                "defined": {
                  "name": "tokenConfig"
                }
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "configArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dwalletProgram",
            "type": "pubkey"
          },
          {
            "name": "btcNetwork",
            "type": {
              "defined": {
                "name": "btcNetwork"
              }
            }
          },
          {
            "name": "maxBtcInputs",
            "type": "u8"
          },
          {
            "name": "evmChains",
            "type": {
              "vec": {
                "defined": {
                  "name": "evmChainConfig"
                }
              }
            }
          },
          {
            "name": "tokens",
            "type": {
              "vec": {
                "defined": {
                  "name": "tokenConfig"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "createAccountArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "index",
            "type": "u16"
          },
          {
            "name": "mode",
            "type": {
              "defined": {
                "name": "mode"
              }
            }
          },
          {
            "name": "userShare",
            "type": {
              "defined": {
                "name": "userShare"
              }
            }
          },
          {
            "name": "ikaUser",
            "type": "pubkey"
          },
          {
            "name": "policy",
            "type": {
              "defined": {
                "name": "policy"
              }
            }
          },
          {
            "name": "recovery",
            "type": {
              "option": {
                "defined": {
                  "name": "recoveryParams"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "dWalletClaim",
      "docs": [
        "One per dWallet: a dWallet can be registered to exactly one account."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          },
          {
            "name": "dwallet",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "dWalletEntry",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dwallet",
            "type": "pubkey"
          },
          {
            "name": "curve",
            "type": "u16"
          },
          {
            "name": "role",
            "type": {
              "defined": {
                "name": "dWalletRole"
              }
            }
          },
          {
            "name": "pubkey",
            "type": {
              "array": [
                "u8",
                33
              ]
            }
          }
        ]
      }
    },
    {
      "name": "dWalletRegistered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          },
          {
            "name": "dwallet",
            "type": "pubkey"
          },
          {
            "name": "role",
            "type": {
              "defined": {
                "name": "dWalletRole"
              }
            }
          }
        ]
      }
    },
    {
      "name": "dWalletRole",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "btc"
          },
          {
            "name": "evm"
          },
          {
            "name": "both"
          }
        ]
      }
    },
    {
      "name": "delayThreshold",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "chain",
            "type": {
              "defined": {
                "name": "chain"
              }
            }
          },
          {
            "name": "asset",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "digestPreview",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "messageDigest",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "finalDigest",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "scheme",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "evmChainConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "chain",
            "type": {
              "defined": {
                "name": "chain"
              }
            }
          },
          {
            "name": "chainId",
            "type": "u64"
          },
          {
            "name": "implementation",
            "docs": [
              "`IkaAccount` delegate implementation on this chain (for EIP-7702 setup)."
            ],
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          }
        ]
      }
    },
    {
      "name": "evmNonce",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "chainId",
            "type": "u64"
          },
          {
            "name": "nonce",
            "docs": [
              "Next `IkaAccount` nonce this program will sign for."
            ],
            "type": "u64"
          },
          {
            "name": "delegated",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "evmParams",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "direct",
            "fields": [
              {
                "name": "nonce",
                "type": "u64"
              },
              {
                "name": "gasLimit",
                "type": "u64"
              },
              {
                "name": "maxFeePerGas",
                "type": "u64"
              },
              {
                "name": "maxPriorityFeePerGas",
                "type": "u64"
              }
            ]
          },
          {
            "name": "delegated",
            "fields": [
              {
                "name": "deadline",
                "type": "i64"
              }
            ]
          },
          {
            "name": "setup",
            "fields": [
              {
                "name": "eoaNonce",
                "type": "u64"
              }
            ]
          },
          {
            "name": "cancelRecovery",
            "fields": [
              {
                "name": "deadline",
                "type": "i64"
              }
            ]
          }
        ]
      }
    },
    {
      "name": "ikaAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "index",
            "type": "u16"
          },
          {
            "name": "mode",
            "type": {
              "defined": {
                "name": "mode"
              }
            }
          },
          {
            "name": "userShare",
            "type": {
              "defined": {
                "name": "userShare"
              }
            }
          },
          {
            "name": "ikaUser",
            "docs": [
              "Ed25519 key authorized to call Ika gRPC `Sign` for this account's approvals."
            ],
            "type": "pubkey"
          },
          {
            "name": "dwallets",
            "type": {
              "vec": {
                "defined": {
                  "name": "dWalletEntry"
                }
              }
            }
          },
          {
            "name": "btcPubkey",
            "type": {
              "array": [
                "u8",
                33
              ]
            }
          },
          {
            "name": "btcPkh",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "evmAddress",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "recoveryPubkey",
            "type": {
              "option": {
                "array": [
                  "u8",
                  33
                ]
              }
            }
          },
          {
            "name": "recoveryEvmAddress",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "csvBlocks",
            "type": "u16"
          },
          {
            "name": "recoveryDelayS",
            "type": "u32"
          },
          {
            "name": "policy",
            "type": {
              "defined": {
                "name": "policy"
              }
            }
          },
          {
            "name": "pendingPolicy",
            "type": {
              "option": {
                "defined": {
                  "name": "policy"
                }
              }
            }
          },
          {
            "name": "pendingPolicyAt",
            "type": "i64"
          },
          {
            "name": "spend",
            "type": {
              "vec": {
                "defined": {
                  "name": "spendWindow"
                }
              }
            }
          },
          {
            "name": "swapSpend",
            "type": {
              "vec": {
                "defined": {
                  "name": "spendWindow"
                }
              }
            }
          },
          {
            "name": "intentNonce",
            "type": "u64"
          },
          {
            "name": "evmNonces",
            "type": {
              "vec": {
                "defined": {
                  "name": "evmNonce"
                }
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "intent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "intentParams"
              }
            }
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "intentStatus"
              }
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "executableAt",
            "type": "i64"
          },
          {
            "name": "evmNonce",
            "docs": [
              "EVM `IkaAccount` nonce bound into the signed digest (delegated / cancel-recovery)."
            ],
            "type": "u64"
          },
          {
            "name": "limitCharge",
            "type": {
              "defined": {
                "name": "charge"
              }
            }
          },
          {
            "name": "swapCharge",
            "type": {
              "defined": {
                "name": "charge"
              }
            }
          },
          {
            "name": "approvals",
            "type": {
              "vec": {
                "defined": {
                  "name": "approval"
                }
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "intentApproved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          },
          {
            "name": "intent",
            "type": "pubkey"
          },
          {
            "name": "evmNonce",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "intentCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          },
          {
            "name": "intent",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "intentKind",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "send"
          },
          {
            "name": "swap"
          },
          {
            "name": "evmSetup"
          },
          {
            "name": "evmCancelRecovery"
          }
        ]
      }
    },
    {
      "name": "intentParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "intentKind"
              }
            }
          },
          {
            "name": "chain",
            "type": {
              "defined": {
                "name": "chain"
              }
            }
          },
          {
            "name": "asset",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "to",
            "docs": [
              "EVM: 20-byte address. Bitcoin: recipient scriptPubKey."
            ],
            "type": "bytes"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "evm",
            "type": {
              "option": {
                "defined": {
                  "name": "evmParams"
                }
              }
            }
          },
          {
            "name": "btc",
            "type": {
              "option": {
                "defined": {
                  "name": "btcParams"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "intentProposed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          },
          {
            "name": "intent",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "executableAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "intentStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "proposed"
          },
          {
            "name": "approved"
          },
          {
            "name": "cancelled"
          }
        ]
      }
    },
    {
      "name": "limit",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "chain",
            "type": {
              "defined": {
                "name": "chain"
              }
            }
          },
          {
            "name": "asset",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "maxPerWindow",
            "type": "u64"
          },
          {
            "name": "windowS",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "mode",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "recoverable"
          },
          {
            "name": "enforced"
          },
          {
            "name": "enforcedRecovery"
          }
        ]
      }
    },
    {
      "name": "policy",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "limits",
            "type": {
              "vec": {
                "defined": {
                  "name": "limit"
                }
              }
            }
          },
          {
            "name": "allowlistEnabled",
            "type": "bool"
          },
          {
            "name": "allowlist",
            "type": {
              "vec": {
                "defined": {
                  "name": "allowEntry"
                }
              }
            }
          },
          {
            "name": "delayThresholds",
            "type": {
              "vec": {
                "defined": {
                  "name": "delayThreshold"
                }
              }
            }
          },
          {
            "name": "delayS",
            "type": "u32"
          },
          {
            "name": "swapsEnabled",
            "type": "bool"
          },
          {
            "name": "swapLimits",
            "type": {
              "vec": {
                "defined": {
                  "name": "limit"
                }
              }
            }
          },
          {
            "name": "maxBtcFeeSats",
            "type": "u64"
          },
          {
            "name": "maxEvmFeeWei",
            "docs": [
              "Cap on `gas_limit * max_fee_per_gas` for direct (self-paid) EVM transactions."
            ],
            "type": "u64"
          },
          {
            "name": "policyChangeDelayS",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "policyApplied",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "policyProposed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          },
          {
            "name": "effectiveAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "recoveryParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pubkey",
            "docs": [
              "Compressed secp256k1 recovery key, generated and kept by the user."
            ],
            "type": {
              "array": [
                "u8",
                33
              ]
            }
          },
          {
            "name": "pubkeyY",
            "docs": [
              "Uncompressed Y of `pubkey`; verified on-chain, used for the EVM address."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "csvBlocks",
            "type": "u16"
          },
          {
            "name": "recoveryDelayS",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "spendWindow",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "windowStart",
            "type": "i64"
          },
          {
            "name": "used",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tokenConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "chain",
            "type": {
              "defined": {
                "name": "chain"
              }
            }
          },
          {
            "name": "address",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          }
        ]
      }
    },
    {
      "name": "userShare",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "public"
          },
          {
            "name": "encrypted"
          }
        ]
      }
    }
  ]
};
