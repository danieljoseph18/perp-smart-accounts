import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../../target/types/perp_margin_accounts";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Set up token mints
const solMint = new PublicKey("So11111111111111111111111111111111111111112");
const usdcMint = process.env.IS_DEVNET
  ? new PublicKey("7ggkvgP7jijLpQBV5GXcqugTMrc2JqDi9tiCH36SVg7A")
  : new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;

  console.log("Program Id: ", program.programId.toString());

  const [marginVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_vault")],
    program.programId
  );

  const solVaultAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    solMint,
    marginVault,
    true
  );

  const usdcVaultAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    usdcMint,
    marginVault,
    true
  );

  // Same as above because admin runs this script
  const adminSolAccount = solVaultAccount;
  const adminUsdcAccount = usdcVaultAccount;

  try {
    program.methods.claimFees().accountsStrict({
      marginVault: marginVault,
      solVault: solVaultAccount.address,
      usdcVault: usdcVaultAccount.address,
      adminSolAccount: adminSolAccount.address,
      adminUsdcAccount: adminUsdcAccount.address,
      authority: provider.wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    });
  } catch (error) {
    console.error(error);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
