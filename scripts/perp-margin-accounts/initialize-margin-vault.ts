import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../../target/types/perp_margin_accounts";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  NATIVE_MINT,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

// USDC token mint on devnet/testnet
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = process.env.IS_DEVNET
  ? new PublicKey("7ggkvgP7jijLpQBV5GXcqugTMrc2JqDi9tiCH36SVg7A")
  : new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

async function main() {
  // Configure the client
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;

  console.log("Program ID:", program.programId.toString());

  // Derive the margin vault PDA
  const [marginVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_vault")],
    program.programId
  );

  // Check if the margin vault account already exists
  const marginVaultAccount = await provider.connection.getAccountInfo(
    marginVault
  );
  if (marginVaultAccount !== null) {
    console.log("Margin vault already initialized:", marginVault.toString());
    console.log("If you want to reinitialize it, you need to close it first.");
    return;
  }

  const solVaultAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    SOL_MINT,
    marginVault,
    true
  );

  const usdcVaultAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    USDC_MINT,
    marginVault,
    true
  );

  // Set withdrawal timelock to 24 hours (in seconds)
  const withdrawalTimelock = 24 * 60 * 60;

  console.log("Initializing margin vault:", marginVault.toString());

  try {
    // First, create the token accounts for SOL and USDC
    console.log("Creating token accounts...");

    // Now initialize the margin vault
    await program.methods
      .initialize(new anchor.BN(withdrawalTimelock))
      .accountsStrict({
        authority: provider.wallet.publicKey,
        marginVault: marginVault,
        solVault: solVaultAccount.address,
        usdcVault: usdcVaultAccount.address,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    console.log("Margin vault initialized successfully!");
  } catch (error) {
    console.error("Failed to initialize margin vault:", error);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
