use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
};

use crate::state::EscrowAccount;

/// SPL Token program ID (hardcoded to avoid type conflicts)
pub const SPL_TOKEN_PROGRAM_ID: Pubkey = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/// Native SOL mint address
pub const NATIVE_MINT: Pubkey = solana_program::pubkey!("So11111111111111111111111111111111111111112");

pub struct TokenTransfer;

impl TokenTransfer {
    /// Transfer SOL from a PDA (program-owned account) to another account
    /// Note: This only works when `from` is owned by the program
    pub fn transfer_sol(
        from: &AccountInfo,
        to: &AccountInfo,
        amount: u64,
    ) -> ProgramResult {
        // Check for underflow
        let from_balance = from.lamports();
        if from_balance < amount {
            msg!("Insufficient SOL balance: have {}, need {}", from_balance, amount);
            return Err(ProgramError::InsufficientFunds);
        }
        
        **from.try_borrow_mut_lamports()? = from_balance
            .checked_sub(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        
        **to.try_borrow_mut_lamports()? = to
            .lamports()
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        
        Ok(())
    }

    /// Transfer SPL tokens using CPI
    /// Builds the instruction manually to avoid type conflicts between spl_token and solana_program
    pub fn transfer_spl_token<'a>(
        from_token_account: &AccountInfo<'a>,
        to_token_account: &AccountInfo<'a>,
        authority: &AccountInfo<'a>,
        token_program: &AccountInfo<'a>,
        amount: u64,
        authority_seeds: Option<&[&[u8]]>,
    ) -> ProgramResult {
        // Validate token program
        if *token_program.key != SPL_TOKEN_PROGRAM_ID {
            msg!("Invalid token program: expected {}, got {}", 
                 SPL_TOKEN_PROGRAM_ID, token_program.key);
            return Err(ProgramError::IncorrectProgramId);
        }

        // Build SPL Token Transfer instruction manually
        // Instruction layout: [instruction_type (1 byte), amount (8 bytes LE)]
        // instruction_type 3 = Transfer
        let mut data = Vec::with_capacity(9);
        data.push(3); // Transfer instruction
        data.extend_from_slice(&amount.to_le_bytes());

        let accounts = vec![
            AccountMeta::new(*from_token_account.key, false),
            AccountMeta::new(*to_token_account.key, false),
            AccountMeta::new_readonly(*authority.key, authority_seeds.is_none()),
        ];

        let ix = Instruction {
            program_id: SPL_TOKEN_PROGRAM_ID,
            accounts,
            data,
        };

        let account_infos = &[
            from_token_account.clone(),
            to_token_account.clone(),
            authority.clone(),
            token_program.clone(),
        ];

        if let Some(seeds) = authority_seeds {
            invoke_signed(&ix, account_infos, &[seeds])
        } else {
            invoke(&ix, account_infos)
        }
    }

    /// Check if mint is the native SOL mint (wrapped SOL)
    pub fn is_native_mint(mint: &Pubkey) -> bool {
        *mint == NATIVE_MINT
    }

    /// Validate that the token program account is the correct SPL Token program
    pub fn validate_token_program(token_program: &AccountInfo) -> ProgramResult {
        if *token_program.key != SPL_TOKEN_PROGRAM_ID {
            msg!("Invalid token program");
            return Err(ProgramError::IncorrectProgramId);
        }
        Ok(())
    }
}

pub struct ValidationHelper;

impl ValidationHelper {
    pub fn validate_signer(account: &AccountInfo, expected_name: &str) -> ProgramResult {
        if !account.is_signer {
            msg!("{} must be signer", expected_name);
            return Err(ProgramError::MissingRequiredSignature);
        }
        Ok(())
    }

    pub fn validate_program_account(
        account: &AccountInfo, 
        program_id: &Pubkey, 
        account_name: &str
    ) -> ProgramResult {
        if account.owner != program_id {
            msg!("{} must be owned by program. Owner: {}, Expected: {}", 
                 account_name, account.owner, program_id);
            return Err(ProgramError::IllegalOwner);
        }
        Ok(())
    }

    pub fn validate_system_program(system_program: &AccountInfo) -> ProgramResult {
        if *system_program.key != solana_program::system_program::id() {
            msg!("Invalid system program");
            return Err(ProgramError::IncorrectProgramId);
        }
        Ok(())
    }

    pub fn validate_vault_pda(
        vault: &AccountInfo,
        escrow_key: &Pubkey,
        program_id: &Pubkey,
        bump: u8,
    ) -> ProgramResult {
        let expected_vault = Pubkey::create_program_address(
            &[b"vault", escrow_key.as_ref(), &[bump]],
            program_id,
        )?;
        
        if expected_vault != *vault.key {
            msg!("Invalid vault PDA: expected {}, got {}", expected_vault, vault.key);
            return Err(ProgramError::InvalidSeeds);
        }
        Ok(())
    }

    pub fn validate_escrow_pda(
        escrow: &AccountInfo,
        initiator: &Pubkey,
        program_id: &Pubkey,
    ) -> Result<u8, ProgramError> {
        let (escrow_pda, bump) = Pubkey::find_program_address(
            &[b"escrow", initiator.as_ref()],
            program_id,
        );
        
        if escrow_pda != *escrow.key {
            msg!("Invalid escrow PDA");
            return Err(ProgramError::InvalidSeeds);
        }
        Ok(bump)
    }

    pub fn validate_escrow_pda_with_seed(
        escrow: &AccountInfo,
        random_seed: &[u8; 32],
        program_id: &Pubkey,
    ) -> Result<u8, ProgramError> {
        let (escrow_pda, bump) = Pubkey::find_program_address(
            &[b"escrow", random_seed],
            program_id,
        );
        
        if escrow_pda != *escrow.key {
            msg!("Invalid escrow PDA with random seed");
            return Err(ProgramError::InvalidSeeds);
        }
        Ok(bump)
    }

    pub fn validate_participant(
        escrow_data: &EscrowAccount,
        participant: &Pubkey,
        expected_role: &str,
    ) -> ProgramResult {
        let is_valid = match expected_role {
            "buyer" => escrow_data.buyer == *participant,
            "seller" => escrow_data.seller == *participant,
            "arbiter" => escrow_data.arbiter == *participant,
            _ => false,
        };

        if !is_valid {
            msg!("Invalid {}: expected one of buyer/seller/arbiter, got {}", 
                 expected_role, participant);
            return Err(ProgramError::IllegalOwner);
        }
        Ok(())
    }

    pub fn validate_instruction_data_length(
        data: &[u8],
        expected_len: usize,
        instruction_name: &str,
    ) -> ProgramResult {
        if data.len() != expected_len {
            msg!(
                "Invalid instruction data length for {}: expected {}, got {}",
                instruction_name,
                expected_len,
                data.len()
            );
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(())
    }

    pub fn validate_fee_collector(
        fee_collector_account: &AccountInfo,
        expected_fee_collector: &Pubkey,
    ) -> ProgramResult {
        if *fee_collector_account.key != *expected_fee_collector {
            msg!("Invalid fee collector account: expected {}, got {}", 
                 expected_fee_collector, fee_collector_account.key);
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(())
    }

    pub fn validate_sufficient_balance(
        account: &AccountInfo,
        required_amount: u64,
        purpose: &str,
    ) -> ProgramResult {
        if account.lamports() < required_amount {
            msg!("Insufficient funds for {}: required {}, available {}", 
                 purpose, required_amount, account.lamports());
            return Err(ProgramError::InsufficientFunds);
        }
        Ok(())
    }

    /// Validate that an account matches expected pubkey
    pub fn validate_account_key(
        account: &AccountInfo,
        expected: &Pubkey,
        account_name: &str,
    ) -> ProgramResult {
        if account.key != expected {
            msg!("Invalid {}: expected {}, got {}", account_name, expected, account.key);
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(())
    }
}

pub struct AccountHelper;

impl AccountHelper {
    pub fn create_pda_account<'a>(
        payer: &AccountInfo<'a>,
        account: &AccountInfo<'a>,
        system_program: &AccountInfo<'a>,
        program_id: &Pubkey,
        seeds: &[&[u8]],
        space: u64,
        lamports: u64,
    ) -> ProgramResult {
        // Validate system program
        ValidationHelper::validate_system_program(system_program)?;
        
        let create_ix = system_instruction::create_account(
            payer.key,
            account.key,
            lamports,
            space,
            program_id,
        );

        invoke_signed(
            &create_ix,
            &[payer.clone(), account.clone(), system_program.clone()],
            &[seeds],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_native_mint_check() {
        assert!(TokenTransfer::is_native_mint(&NATIVE_MINT));
        assert!(!TokenTransfer::is_native_mint(&Pubkey::default()));
    }

    #[test]
    fn test_spl_token_program_id() {
        // Verify the hardcoded SPL Token program ID is correct
        assert_eq!(
            SPL_TOKEN_PROGRAM_ID.to_string(),
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        );
    }
}