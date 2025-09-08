use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
};
use spl_token::solana_program::pubkey as spl_pubkey;

use crate::state::EscrowAccount;

pub struct TokenTransfer;

impl TokenTransfer {
    pub fn transfer_sol(
        from: &AccountInfo,
        to: &AccountInfo,
        amount: u64,
    ) -> ProgramResult {
        **from.try_borrow_mut_lamports()? -= amount;
        **to.try_borrow_mut_lamports()? += amount;
        Ok(())
    }

    pub fn transfer_spl_token<'a>(
        from_token_account: &AccountInfo<'a>,
        to_token_account: &AccountInfo<'a>,
        authority: &AccountInfo<'a>,
        token_program: &AccountInfo<'a>,
        amount: u64,
        authority_seeds: Option<&[&[u8]]>,
    ) -> ProgramResult {
        let ix = spl_token::instruction::transfer(
            &spl_pubkey::Pubkey::new_from_array(token_program.key.to_bytes()),
            &spl_pubkey::Pubkey::new_from_array(from_token_account.key.to_bytes()),
            &spl_pubkey::Pubkey::new_from_array(to_token_account.key.to_bytes()),
            &spl_pubkey::Pubkey::new_from_array(authority.key.to_bytes()),
            &[],
            amount,
        ).map_err(|_| ProgramError::Custom(1))?;

        let ix: solana_program::instruction::Instruction = unsafe { std::mem::transmute(ix) };

        if let Some(seeds) = authority_seeds {
            invoke_signed(
                &ix,
                &[
                    from_token_account.clone(),
                    to_token_account.clone(),
                    authority.clone(),
                    token_program.clone(),
                ],
                &[seeds],
            )
        } else {
            invoke(
                &ix,
                &[
                    from_token_account.clone(),
                    to_token_account.clone(),
                    authority.clone(),
                    token_program.clone(),
                ],
            )
        }
    }

    pub fn is_native_mint(mint: &Pubkey) -> bool {
        let native_mint = Pubkey::new_from_array(spl_token::native_mint::id().to_bytes());
        *mint == native_mint
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

    pub fn validate_program_account(account: &AccountInfo, program_id: &Pubkey, account_name: &str) -> ProgramResult {
        if account.owner != program_id {
            msg!("{} must be owned by program", account_name);
            return Err(ProgramError::IllegalOwner);
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
            msg!("Invalid vault PDA");
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
            msg!("Invalid {}", expected_role);
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
            msg!("Invalid fee collector account");
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