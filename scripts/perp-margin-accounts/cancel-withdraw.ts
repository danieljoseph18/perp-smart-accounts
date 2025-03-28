import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../../target/types/perp_margin_accounts";
import { PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  // Configure the client to use the specified cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const marginProgram = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;

  // Parse command line arguments
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: ts-node cancel-withdraw.ts <owner_public_key>");
    process.exit(1);
  }

  const ownerPublicKey = new PublicKey(args[0]);

  // Derive margin account PDA
  const [marginAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_account"), ownerPublicKey.toBuffer()],
    marginProgram.programId
  );

  // Derive margin vault PDA
  const [marginVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_vault")],
    marginProgram.programId
  );

  console.log(`Cancelling withdrawal for account: ${marginAccount.toString()}`);

  try {
    // Call the cancel withdrawal instruction
    const tx = await marginProgram.methods
      .cancelWithdrawal()
      .accountsStrict({
        marginAccount: marginAccount,
        marginVault: marginVault,
        authority: provider.wallet.publicKey,
      })
      .signers([provider.wallet.payer])
      .rpc();

    console.log(`Transaction successful: ${tx}`);
    console.log(
      `Cancelled withdrawal for account: ${marginAccount.toString()}`
    );
  } catch (error) {
    console.error(`Error cancelling withdrawal:`, error);
  }
}

main().catch((error) => {
  console.error("Script failed:", error);
  process.exit(1);
});
