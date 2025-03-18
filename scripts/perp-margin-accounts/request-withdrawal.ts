import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../../target/types/perp_margin_accounts";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import * as dotenv from "dotenv";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

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
  const solAmount = new anchor.BN(args[0] || "0");
  const usdcAmount = new anchor.BN(args[1] || "0");

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

  console.log(
    "Requesting withdrawal from margin account:",
    marginAccount.toString()
  );
  console.log("SOL amount:", solAmount.toString());
  console.log("USDC amount:", usdcAmount.toString());

  try {
    await program.methods
      .requestWithdrawal(solAmount, usdcAmount)
      .accountsStrict({
        marginAccount: marginAccount,
        marginVault: marginVault,
        owner: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Withdrawal request submitted successfully!");
  } catch (error) {
    console.error("Failed to request withdrawal:", error);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
