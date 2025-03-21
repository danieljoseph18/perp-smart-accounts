import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../../target/types/perp_margin_accounts";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const WITHDRAWAL_TIMELOCK = 1; // 1 seconds

export async function initializeMarginProgram(
  provider: anchor.AnchorProvider,
  program: Program<PerpMarginAccounts>,
  solMint: PublicKey,
  usdcMint: PublicKey,
  chainlinkProgram: PublicKey,
  chainlinkFeed: PublicKey,
  admin: anchor.web3.Keypair
) {
  console.log("\n=== Initializing Margin Program ===");

  // Derive PDAs
  const [marginVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_vault")],
    program.programId
  );

  console.log("Margin Vault PDA:", marginVault.toString());

  // Check if margin vault already exists
  const marginVaultInfo = await provider.connection.getAccountInfo(marginVault);

  // If margin vault already exists, get existing vaults
  if (marginVaultInfo) {
    console.log("✓ Margin program already initialized, retrieving vaults");

    const marginVaultAccount = await program.account.marginVault.fetch(
      marginVault
    );

    return {
      marginVault,
      marginSolVault: marginVaultAccount.marginSolVault,
      marginUsdcVault: marginVaultAccount.marginUsdcVault,
      chainlinkProgram,
      chainlinkFeed,
    };
  }

  try {
    // Create new token vaults with marginVault as owner
    const solVaultAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      solMint,
      marginVault,
      true
    );

    console.log(
      "Margin Program SOL vault:",
      solVaultAccount.address.toString()
    );

    const usdcVaultAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      marginVault,
      true
    );

    console.log(
      "Margin Program USDC vault:",
      usdcVaultAccount.address.toString()
    );

    // First initialize the margin vault
    await program.methods
      .initialize(
        new anchor.BN(WITHDRAWAL_TIMELOCK),
        chainlinkProgram,
        chainlinkFeed
      )
      .accountsStrict({
        authority: admin.publicKey,
        marginVault,
        marginSolVault: solVaultAccount.address,
        marginUsdcVault: usdcVaultAccount.address,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    console.log("✓ Margin program initialized successfully!");
    console.log("Margin SOL vault:", solVaultAccount.address.toString());
    console.log("Margin USDC vault:", usdcVaultAccount.address.toString());

    return {
      marginVault,
      marginSolVault: solVaultAccount.address,
      marginUsdcVault: usdcVaultAccount.address,
      chainlinkProgram,
      chainlinkFeed,
    };
  } catch (error) {
    console.error("Failed to initialize margin program:", error);
    throw error;
  }
}
