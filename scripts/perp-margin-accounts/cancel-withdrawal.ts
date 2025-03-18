import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../../target/types/perp_margin_accounts";
import { PublicKey } from "@solana/web3.js";
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

  // Get command line arguments for the account owner
  const args = process.argv.slice(2);
  const accountOwner = args[0]
    ? new PublicKey(args[0])
    : provider.wallet.publicKey;

  // Derive the margin account PDA for the target user
  const [marginAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_account"), accountOwner.toBuffer()],
    program.programId
  );

  // Derive the margin vault PDA
  const [marginVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_vault")],
    program.programId
  );

  console.log(
    "Cancelling withdrawal for margin account:",
    marginAccount.toString()
  );
  console.log("Account owner:", accountOwner.toString());

  try {
    await program.methods
      .cancelWithdrawal()
      .accountsStrict({
        marginAccount: marginAccount,
        marginVault: marginVault,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    console.log("Withdrawal cancelled successfully!");
  } catch (error) {
    console.error("Failed to cancel withdrawal:", error);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
