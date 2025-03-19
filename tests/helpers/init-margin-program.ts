import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../../target/types/perp_margin_accounts";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const WITHDRAWAL_TIMELOCK = 5 * 60; // 5 minutes in seconds

export async function initializeMarginProgram(
  provider: anchor.AnchorProvider,
  program: Program<PerpMarginAccounts>,
  solVault: PublicKey,
  usdcVault: PublicKey,
  chainlinkProgram: PublicKey,
  chainlinkFeed: PublicKey
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
  
  // If margin vault already exists, we don't need to initialize again
  if (marginVaultInfo) {
    console.log("✓ Margin program already initialized, skipping initialization");
    return {
      marginVault,
      solVault,
      usdcVault,
      chainlinkProgram,
      chainlinkFeed,
    };
  }

  try {
    await program.methods
      .initialize(
        new anchor.BN(WITHDRAWAL_TIMELOCK),
        chainlinkProgram,
        chainlinkFeed
      )
      .accountsStrict({
        authority: provider.wallet.publicKey,
        marginVault,
        solVault,
        usdcVault,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    console.log("✓ Margin program initialized successfully!");
    return {
      marginVault,
      solVault,
      usdcVault,
      chainlinkProgram,
      chainlinkFeed,
    };
  } catch (error) {
    console.error("Failed to initialize margin program:", error);
    throw error;
  }
}
