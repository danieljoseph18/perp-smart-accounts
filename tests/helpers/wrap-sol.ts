import { PublicKey, SystemProgram } from "@solana/web3.js";
import { Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createSyncNativeInstruction,
} from "@solana/spl-token";

// Helper function to wrap native SOL to WSOL
export async function wrapSol(
  fromPubkey: PublicKey,
  toTokenAccount: PublicKey,
  amount: number,
  provider: anchor.AnchorProvider,
  signer: Keypair
) {
  // Transfer SOL to the token account
  const wrapIx = SystemProgram.transfer({
    fromPubkey,
    toPubkey: toTokenAccount,
    lamports: amount,
  });

  // Create a sync instruction so the WSOL amount is updated
  const syncIx = createSyncNativeInstruction(toTokenAccount);

  // Add both instructions to the transaction
  const wrapTx = new anchor.web3.Transaction().add(wrapIx, syncIx);

  await provider.sendAndConfirm(wrapTx, [signer]);
}
