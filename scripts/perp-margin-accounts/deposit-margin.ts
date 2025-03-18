import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../../target/types/perp_margin_accounts";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

async function main() {
  // Configure the client
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;

  console.log("Program ID:", program.programId.toString());

  // Get command line arguments
  const args = process.argv.slice(2);
  const amount = new anchor.BN(args[0] || "1000000"); // Default 1 SOL/USDC
  const isUsdc = args[1] === "usdc";

  // Derive the margin account PDA for the user
  const [marginAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_account"), provider.wallet.publicKey.toBuffer()],
    program.programId
  );

  // Derive the margin vault PDA
  const [marginVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_vault")],
    program.programId
  );

  // Get the appropriate vault based on token type
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from(isUsdc ? "usdc_vault" : "sol_vault")],
    program.programId
  );

  console.log("Depositing to margin account:", marginAccount.toString());
  console.log("Amount:", amount.toString());
  console.log("Token:", isUsdc ? "USDC" : "SOL");

  try {
    if (isUsdc) {
      // For USDC deposits
      const userUsdcAta = await getAssociatedTokenAddress(
        new PublicKey(process.env.USDC_MINT!),
        provider.wallet.publicKey
      );

      await program.methods
        .depositMargin(amount)
        .accountsStrict({
          owner: provider.wallet.publicKey,
          marginAccount: marginAccount,
          marginVault: marginVault,
          vaultTokenAccount: vault,
          userTokenAccount: userUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else {
      const userSolAta = await getAssociatedTokenAddress(
        new PublicKey(process.env.SOL_MINT!),
        provider.wallet.publicKey
      );

      // For SOL deposits
      await program.methods
        .depositMargin(amount)
        .accountsStrict({
          owner: provider.wallet.publicKey,
          marginAccount: marginAccount,
          marginVault: marginVault,
          vaultTokenAccount: vault,
          userTokenAccount: userSolAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    console.log("Deposit successful!");
  } catch (error) {
    console.error("Failed to deposit margin:", error);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
