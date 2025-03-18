import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../../target/types/perp_margin_accounts";
import { PublicKey } from "@solana/web3.js";
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
  const pnlUpdate = new anchor.BN(args[0] || "0");
  const lockedSol = new anchor.BN(args[1] || "0");
  const lockedUsdc = new anchor.BN(args[2] || "0");
  const solFeesOwed = new anchor.BN(args[3] || "0");
  const usdcFeesOwed = new anchor.BN(args[4] || "0");

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

  // Get the vault PDAs
  const [solVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("sol-vault")],
    program.programId
  );

  const [usdcVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("usdc-vault")],
    program.programId
  );

  // Get user's USDC ATA
  const userUsdcAta = await getAssociatedTokenAddress(
    new PublicKey(process.env.USDC_MINT!),
    provider.wallet.publicKey
  );

  // Get user's SOL ATA
  const userSolAta = await getAssociatedTokenAddress(
    new PublicKey(process.env.SOL_MINT!),
    provider.wallet.publicKey
  );

  // Derive the pool state PDA
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-state")],
    new PublicKey(process.env.PERP_AMM_PROGRAM_ID!)
  );

  console.log(
    "Executing withdrawal for margin account:",
    marginAccount.toString()
  );
  console.log("PnL update:", pnlUpdate.toString());

  try {
    await program.methods
      .executeWithdrawal(
        pnlUpdate,
        lockedSol,
        lockedUsdc,
        solFeesOwed,
        usdcFeesOwed
      )
      .accountsStrict({
        marginAccount,
        marginVault,
        solVault: solVault,
        usdcVault: usdcVault,
        userSolAccount: userSolAta,
        userUsdcAccount: userUsdcAta,
        poolState,
        poolVaultAccount: usdcVault, // or solVault depending on which token you're withdrawing
        chainlinkProgram: new PublicKey(process.env.CHAINLINK_PROGRAM_ID!),
        chainlinkFeed: new PublicKey(process.env.SOL_PRICE_FEED!),
        authority: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        liquidityPoolProgram: new PublicKey(process.env.PERP_AMM_PROGRAM_ID!),
      })
      .rpc();

    console.log("Withdrawal executed successfully!");
  } catch (error) {
    console.error("Failed to execute withdrawal:", error);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
