import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../../target/types/perp_margin_accounts";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import * as dotenv from "dotenv";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

// Load environment variables
dotenv.config();

const withdrawalTimelock = new BN(300);

async function main() {
  // Configure the client
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;

  console.log("Program ID:", program.programId.toString());

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

  const [solVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("sol_vault")],
    program.programId
  );

  const [usdcVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("usdc_vault")],
    program.programId
  );

  console.log("Initializing margin account:", marginAccount.toString());
  console.log("For user:", provider.wallet.publicKey.toString());

  try {
    await program.methods
      .initialize(withdrawalTimelock)
      .accountsStrict({
        authority: provider.wallet.publicKey,
        marginVault: marginVault,
        solVault: solVault,
        usdcVault: usdcVault,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    console.log("Margin account initialized successfully!");
  } catch (error) {
    console.error("Failed to initialize margin account:", error);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
