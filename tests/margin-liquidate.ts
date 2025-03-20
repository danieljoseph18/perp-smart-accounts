import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../target/types/perp_margin_accounts";
import { PerpAmm } from "../target/types/perp_amm";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";
import * as dotenv from "dotenv";
import { initializeMarginProgram } from "./helpers/init-margin-program";
import { setupAmmProgram } from "./helpers/init-amm-program";

dotenv.config();

// These are the chainlink-related addresses used by the margin program.
const CHAINLINK_PROGRAM = new PublicKey(
  "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny"
);
const CHAINLINK_FEED = new PublicKey(
  "99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR"
);

describe("perp-margin-accounts", () => {
  // Use separate program clients for the AMM and the margin program.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const ammProgram = anchor.workspace.PerpAmm as Program<PerpAmm>;
  const marginProgram = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;

  // Use fixed keypairs for admin and a liquidator (unauthorized)
  const admin = Keypair.fromSeed(Uint8Array.from(Array(32).fill(1)));
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();
  const liquidator = Keypair.generate();

  // AMM configuration (pool state, vaults, mints, etc.)
  let poolStatePda: PublicKey;
  let ammSolVault: PublicKey;
  let ammUsdcVault: PublicKey;

  // Margin program vault information (returned from initializeMarginProgram)
  let marginVault: PublicKey;
  let marginSolVault: PublicKey;
  let marginUsdcVault: PublicKey;

  // Token mints
  let solMint: PublicKey;
  let usdcMint: PublicKey;
  let lpTokenMint: PublicKey;

  // User token accounts (for receiving tokens and paying fees)
  let adminSolAccount: PublicKey;
  let adminUsdcAccount: PublicKey;
  let user1UsdcAccount: PublicKey;
  let user2UsdcAccount: PublicKey;
  let user1SolAccount: PublicKey;
  let user2SolAccount: PublicKey;

  // User margin accounts (PDAs derived with ["margin_account", user.publicKey])
  let user1MarginAccount: PublicKey;
  let user2MarginAccount: PublicKey;

  // Test deposit amounts
  const initialSolDeposit = new BN(2 * LAMPORTS_PER_SOL);
  const initialUsdcDeposit = new BN(10_000_000); // 10 USDC with 6 decimals

  before(async () => {
    console.log("=== Starting test setup ===");

    // Set up the AMM program. This helper creates the pool state, mints, vaults and
    // associated user token accounts.
    const ammSetup = await setupAmmProgram(
      provider,
      ammProgram,
      marginProgram, // passed in case the AMM setup also needs the margin program
      CHAINLINK_PROGRAM,
      CHAINLINK_FEED,
      admin,
      user1,
      user2
    );

    // The AMM setup returns the pool state PDA as well as the vaults and mint addresses.
    poolStatePda = ammSetup.poolState;
    solMint = ammSetup.solMint;
    usdcMint = ammSetup.usdcMint;
    lpTokenMint = ammSetup.lpTokenMint;
    ammSolVault = ammSetup.solVault;
    ammUsdcVault = ammSetup.usdcVault;
    adminSolAccount = ammSetup.adminSolAccount;
    adminUsdcAccount = ammSetup.adminUsdcAccount;
    user1UsdcAccount = ammSetup.user1UsdcAccount;
    user2UsdcAccount = ammSetup.user2UsdcAccount;

    // Create associated token accounts for SOL (wrapped SOL) for our users.
    user1SolAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        solMint,
        user1.publicKey
      )
    ).address;
    user2SolAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        solMint,
        user2.publicKey
      )
    ).address;

    marginVault = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_vault")],
      marginProgram.programId
    )[0];

    marginSolVault = ammSetup.solVault;
    marginUsdcVault = ammSetup.usdcVault;

    // Derive the margin account PDAs for user1 and user2.
    [user1MarginAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_account"), user1.publicKey.toBuffer()],
      marginProgram.programId
    );
    [user2MarginAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_account"), user2.publicKey.toBuffer()],
      marginProgram.programId
    );

    // Ensure admin, users, and liquidator have sufficient SOL for fees.
    await Promise.all([
      ensureMinimumBalance(admin.publicKey, 5 * LAMPORTS_PER_SOL),
      ensureMinimumBalance(user1.publicKey, 5 * LAMPORTS_PER_SOL),
      ensureMinimumBalance(user2.publicKey, 5 * LAMPORTS_PER_SOL),
      ensureMinimumBalance(liquidator.publicKey, 5 * LAMPORTS_PER_SOL),
    ]);
  });

  // Helper: airdrop SOL if needed
  async function ensureMinimumBalance(address: PublicKey, minBalance: number) {
    const balance = await provider.connection.getBalance(address);
    if (balance < minBalance) {
      console.log(`Airdropping SOL to ${address.toString()}...`);
      const airdropTx = await provider.connection.requestAirdrop(
        address,
        minBalance - balance
      );
      await provider.connection.confirmTransaction(airdropTx);
    }
  }

  describe("liquidate_margin_account", () => {
    it("should liquidate a margin account's SOL balance", async () => {
      // First, deposit SOL into user1's margin account.
      await marginProgram.methods
        .depositMargin(initialSolDeposit)
        .accountsStrict({
          marginAccount: user1MarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: marginSolVault,
          userTokenAccount: user1SolAccount,
          owner: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      // Fetch margin account state before liquidation.
      const marginAccountBefore =
        await marginProgram.account.marginAccount.fetch(user1MarginAccount);
      const depositedSol = marginAccountBefore.solBalance;
      assert.equal(
        depositedSol.toString(),
        initialSolDeposit.toString(),
        "Initial SOL balance should match deposit amount"
      );

      // Capture the pool SOL vault balance before liquidation.
      const poolSolBefore = await getAccount(provider.connection, ammSolVault);
      const poolSolAmountBefore = new BN(poolSolBefore.amount.toString());

      // Call the liquidation instruction.
      await marginProgram.methods
        .liquidateMarginAccount()
        .accountsStrict({
          marginAccount: user1MarginAccount,
          marginVault: marginVault,
          marginVaultTokenAccount: marginSolVault,
          poolState: poolStatePda,
          poolVaultAccount: ammSolVault,
          chainlinkProgram: CHAINLINK_PROGRAM,
          chainlinkFeed: CHAINLINK_FEED,
          authority: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          liquidityPoolProgram: ammProgram.programId,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      console.log("Liquidation transaction for SOL completed.");

      // Fetch margin account state after liquidation.
      const marginAccountAfter =
        await marginProgram.account.marginAccount.fetch(user1MarginAccount);
      assert.equal(
        marginAccountAfter.solBalance.toString(),
        "0",
        "SOL balance should be zero after liquidation"
      );

      // Verify that the AMM pool vault increased by the deposited amount.
      const poolSolAfter = await getAccount(provider.connection, ammSolVault);
      const poolSolAmountAfter = new BN(poolSolAfter.amount.toString());
      const diff = poolSolAmountAfter.sub(poolSolAmountBefore);
      assert.equal(
        diff.toString(),
        initialSolDeposit.toString(),
        "Pool SOL vault should increase by the liquidated amount"
      );
    });

    it("should liquidate a margin account's USDC balance", async () => {
      // Deposit USDC into user2's margin account.
      await marginProgram.methods
        .depositMargin(initialUsdcDeposit)
        .accountsStrict({
          marginAccount: user2MarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: marginUsdcVault,
          userTokenAccount: user2UsdcAccount,
          owner: user2.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      // Fetch margin account state before liquidation.
      const marginAccountBefore =
        await marginProgram.account.marginAccount.fetch(user2MarginAccount);
      const depositedUsdc = marginAccountBefore.usdcBalance;
      assert.equal(
        depositedUsdc.toString(),
        initialUsdcDeposit.toString(),
        "Initial USDC balance should match deposit amount"
      );

      // Capture the pool USDC vault balance before liquidation.
      const poolUsdcBefore = await getAccount(
        provider.connection,
        ammUsdcVault
      );
      const poolUsdcAmountBefore = new BN(poolUsdcBefore.amount.toString());

      // Call the liquidation instruction.
      await marginProgram.methods
        .liquidateMarginAccount()
        .accountsStrict({
          marginAccount: user2MarginAccount,
          marginVault: marginVault,
          marginVaultTokenAccount: marginUsdcVault,
          poolState: poolStatePda,
          poolVaultAccount: ammUsdcVault,
          chainlinkProgram: CHAINLINK_PROGRAM,
          chainlinkFeed: CHAINLINK_FEED,
          authority: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          liquidityPoolProgram: ammProgram.programId,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      console.log("Liquidation transaction for USDC completed.");

      // Fetch margin account state after liquidation.
      const marginAccountAfter =
        await marginProgram.account.marginAccount.fetch(user2MarginAccount);
      assert.equal(
        marginAccountAfter.usdcBalance.toString(),
        "0",
        "USDC balance should be zero after liquidation"
      );

      // Verify that the AMM pool vault increased by the liquidated amount.
      const poolUsdcAfter = await getAccount(provider.connection, ammUsdcVault);
      const poolUsdcAmountAfter = new BN(poolUsdcAfter.amount.toString());
      const diff = poolUsdcAmountAfter.sub(poolUsdcAmountBefore);
      assert.equal(
        diff.toString(),
        initialUsdcDeposit.toString(),
        "Pool USDC vault should increase by the liquidated amount"
      );
    });

    it("should fail to liquidate with an unauthorized authority", async () => {
      try {
        // Attempt liquidation using an unauthorized authority.
        await marginProgram.methods
          .liquidateMarginAccount()
          .accountsStrict({
            marginAccount: user1MarginAccount,
            marginVault: marginVault,
            marginVaultTokenAccount: marginSolVault,
            poolState: poolStatePda,
            poolVaultAccount: ammSolVault,
            chainlinkProgram: CHAINLINK_PROGRAM,
            chainlinkFeed: CHAINLINK_FEED,
            authority: liquidator.publicKey, // Unauthorized!
            tokenProgram: TOKEN_PROGRAM_ID,
            liquidityPoolProgram: ammProgram.programId,
            systemProgram: SystemProgram.programId,
          })
          .signers([liquidator])
          .rpc();

        assert.fail("Expected transaction to fail with unauthorized authority");
      } catch (error: any) {
        assert.include(
          error.toString(),
          "UnauthorizedLiquidation",
          "Expected error about unauthorized liquidation"
        );
      }
    });

    it("should test liquidation of zero balances (no-op)", async () => {
      // Create a new user with a fresh margin account with zero balances.
      const zeroBalanceUser = Keypair.generate();
      await ensureMinimumBalance(
        zeroBalanceUser.publicKey,
        2 * LAMPORTS_PER_SOL
      );

      const [zeroMarginAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("margin_account"), zeroBalanceUser.publicKey.toBuffer()],
        marginProgram.programId
      );

      // Confirm that the initial balances are zero.
      const initialAccount = await marginProgram.account.marginAccount.fetch(
        zeroMarginAccount
      );
      assert.equal(
        initialAccount.solBalance.toString(),
        "0",
        "Initial SOL balance should be zero"
      );
      assert.equal(
        initialAccount.usdcBalance.toString(),
        "0",
        "Initial USDC balance should be zero"
      );

      // Attempt liquidation on the zero-balance margin account.
      await marginProgram.methods
        .liquidateMarginAccount()
        .accountsStrict({
          marginAccount: zeroMarginAccount,
          marginVault: marginVault,
          marginVaultTokenAccount: marginSolVault, // using the SOL vault as example
          poolState: poolStatePda,
          poolVaultAccount: ammSolVault,
          chainlinkProgram: CHAINLINK_PROGRAM,
          chainlinkFeed: CHAINLINK_FEED,
          authority: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          liquidityPoolProgram: ammProgram.programId,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      // Verify that the account's balances remain zero.
      const finalAccount = await marginProgram.account.marginAccount.fetch(
        zeroMarginAccount
      );
      assert.equal(
        finalAccount.solBalance.toString(),
        "0",
        "Final SOL balance should still be zero"
      );
      assert.equal(
        finalAccount.usdcBalance.toString(),
        "0",
        "Final USDC balance should still be zero"
      );
    });
  });
});
