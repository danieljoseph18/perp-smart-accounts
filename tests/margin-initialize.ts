import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../target/types/perp_margin_accounts";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getOrCreateAssociatedTokenAccount,
  createMint,
} from "@solana/spl-token";
import { expect } from "chai";

describe("perp-margin-accounts initialize", () => {
  // Configure the client
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;

  // Mock USDC mint for testing
  let usdcMint: PublicKey;
  let solMint: PublicKey;
  let marginVault: PublicKey;
  let solVaultAccount: PublicKey;
  let usdcVaultAccount: PublicKey;

  const withdrawalTimelock = 24 * 60 * 60; // 24 hours in seconds

  before(async () => {
    console.log("Program ID:", program.programId.toString());

    // Create mock USDC mint
    usdcMint = await createMint(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      provider.wallet.publicKey,
      provider.wallet.publicKey,
      6
    );
    console.log("Created USDC mint:", usdcMint.toString());

    // Use native SOL mint for SOL
    solMint = NATIVE_MINT;
    console.log("Using SOL mint:", solMint.toString());

    // Derive the margin vault PDA to match the program's seed
    [marginVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_vault")],
      program.programId
    );
    console.log("Margin vault PDA:", marginVault.toString());
  });

  it("Should initialize a margin vault", async () => {
    // First, create the token accounts for SOL and USDC
    const solVault = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      solMint,
      marginVault,
      true
    );
    solVaultAccount = solVault.address;
    console.log("Created SOL vault:", solVaultAccount.toString());

    const usdcVault = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      marginVault,
      true
    );
    usdcVaultAccount = usdcVault.address;
    console.log("Created USDC vault:", usdcVaultAccount.toString());

    // Initialize the margin vault
    await program.methods
      .initialize(new anchor.BN(withdrawalTimelock))
      .accountsStrict({
        authority: provider.wallet.publicKey,
        marginVault: marginVault,
        solVault: solVaultAccount,
        usdcVault: usdcVaultAccount,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Fetch the margin vault account to verify it was initialized correctly
    const marginVaultAccount = await program.account.marginVault.fetch(
      marginVault
    );

    // Verify the vault's fields were set correctly
    expect(marginVaultAccount.solVault.toString()).to.equal(
      solVaultAccount.toString()
    );
    expect(marginVaultAccount.usdcVault.toString()).to.equal(
      usdcVaultAccount.toString()
    );
    expect(marginVaultAccount.authority.toString()).to.equal(
      provider.wallet.publicKey.toString()
    );
    expect(marginVaultAccount.withdrawalTimelock.toString()).to.equal(
      withdrawalTimelock.toString()
    );
    expect(marginVaultAccount.solFeesAccumulated.toString()).to.equal("0");
    expect(marginVaultAccount.usdcFeesAccumulated.toString()).to.equal("0");
  });

  it("Should fail to reinitialize an existing margin vault", async () => {
    try {
      // Attempt to initialize the margin vault again
      await program.methods
        .initialize(new anchor.BN(withdrawalTimelock))
        .accountsStrict({
          authority: provider.wallet.publicKey,
          marginVault: marginVault,
          solVault: solVaultAccount,
          usdcVault: usdcVaultAccount,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      // If we get here, the test should fail
      expect.fail("Should have thrown an error when reinitializing vault");
    } catch (error: any) {
      // We expect an error about the account being already initialized
      expect(error.toString()).to.include("Error");
    }
  });

  it("Should fail to initialize with invalid token accounts", async () => {
    // Create a new margin vault PDA for this test with a different seed
    const [newMarginVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_vault_test")],
      program.programId
    );

    // Create token accounts owned by the wallet instead of the PDA
    const invalidSolVault = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      solMint,
      provider.wallet.publicKey
    );

    try {
      // Attempt to initialize with invalid token accounts
      await program.methods
        .initialize(new anchor.BN(withdrawalTimelock))
        .accountsStrict({
          authority: provider.wallet.publicKey,
          marginVault: newMarginVault,
          solVault: invalidSolVault.address,
          usdcVault: usdcVaultAccount, // This is still valid
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      // If we get here, the test should fail
      expect.fail("Should have thrown a constraint error");
    } catch (error: any) {
      // We expect a constraint error
      expect(error.toString()).to.include("Constraint");
    }
  });
});
