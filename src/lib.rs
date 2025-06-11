use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    system_program,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq)]
/// Possible states of the escrow contract
pub enum EscrowState {
    Uninitialized = 0,
    Created = 1,     
    Initialized = 2, 
    Funded = 3,
    Completed = 4,
    Cancelled = 5,
}

#[repr(C)]
#[derive(Debug)]
/// Main escrow account data
pub struct EscrowAccount {
    buyer: Pubkey,       
    seller: Pubkey,       
    arbiter: Pubkey,      
    amount: u64,
    state: u8,
    vault_bump: u8,
}

impl EscrowAccount {
    const LEN: usize = 32 + 32 + 32 + 8 + 1 + 1;

    fn new(
        buyer: &Pubkey,
        arbiter: &Pubkey,
        amount: u64,
        vault_bump: u8,
    ) -> Self {
        Self {
            buyer: *buyer,
            seller: Pubkey::default(),
            arbiter: *arbiter,
            amount,
            state: EscrowState::Created as u8,
            vault_bump,
        }
    }
    
    fn from_account_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != Self::LEN {
            msg!("Invalid account size: expected {}, got {}", Self::LEN, data.len());
            return Err(ProgramError::InvalidAccountData);
        }
        
        let buyer = Pubkey::new_from_array(data[0..32].try_into().unwrap());
        let seller = Pubkey::new_from_array(data[32..64].try_into().unwrap());
        let arbiter = Pubkey::new_from_array(data[64..96].try_into().unwrap());
        let amount = u64::from_le_bytes(data[96..104].try_into().unwrap());
        let state = data[104];
        let vault_bump = data[105];
        
        Ok(Self {
            buyer,
            seller,
            arbiter,
            amount,
            state,
            vault_bump,
        })
    }
    
    fn save_to_account(&self, account: &AccountInfo) -> ProgramResult {
        let mut data = account.try_borrow_mut_data()?;
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        
        data[0..32].copy_from_slice(self.buyer.as_ref());
        data[32..64].copy_from_slice(self.seller.as_ref());
        data[64..96].copy_from_slice(self.arbiter.as_ref());
        data[96..104].copy_from_slice(&self.amount.to_le_bytes());
        data[104] = self.state;
        data[105] = self.vault_bump;
        
        Ok(())
    }
    
    fn get_state(&self) -> Result<EscrowState, ProgramError> {
        match self.state {
            0 => Ok(EscrowState::Uninitialized),
            1 => Ok(EscrowState::Created),
            2 => Ok(EscrowState::Initialized),
            3 => Ok(EscrowState::Funded),
            4 => Ok(EscrowState::Completed),
            5 => Ok(EscrowState::Cancelled),
            _ => {
                msg!("Invalid escrow state: {}", self.state);
                Err(ProgramError::InvalidAccountData)
            }
        }
    }
    
    fn set_state(&mut self, state: EscrowState) {
        self.state = state as u8;
    }
}

entrypoint!(process_instruction);

/// Main entrypoint. Dispatches instructions by index.
fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    
    let instruction_type = instruction_data[0];
    match instruction_type {
        0 => create_offer(program_id, accounts, instruction_data),
        1 => join_offer(program_id, accounts, instruction_data),
        2 => fund_escrow(program_id, accounts),
        3 => confirm_escrow(program_id, accounts),
        4 => arbiter_confirm(program_id, accounts),
        5 => arbiter_cancel(program_id, accounts),
        6 => close_escrow(program_id, accounts),
        7 => get_escrow_info(program_id, accounts),
        8 => mutual_cancel(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Create offer (instruction_data: [0, amount(8 bytes), arbiter(32 bytes)])
fn create_offer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() != 41 { // 1 + 8 + 32
        msg!("Invalid instruction data length");
        return Err(ProgramError::InvalidInstructionData);
    }
    
    let amount = u64::from_le_bytes(instruction_data[1..9].try_into().unwrap());
    let arbiter = Pubkey::new_from_array(instruction_data[9..41].try_into().unwrap());

    let accounts_iter = &mut accounts.iter();
    let buyer = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;

    if !buyer.is_signer {
        msg!("Buyer must be signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    let (vault_pda, vault_bump) = Pubkey::find_program_address(
        &[b"vault", escrow_account.key.as_ref()],
        program_id,
    );
    if vault_pda != *vault.key {
        msg!("Invalid vault PDA");
        return Err(ProgramError::InvalidSeeds);
    }

    let escrow_data = EscrowAccount::new(
        buyer.key,
        &arbiter,
        amount,
        vault_bump,
    );
    
    let rent = Rent::get()?;
    let required_lamports = rent.minimum_balance(0); 
    
    if vault.lamports() == 0 {
        let create_ix = system_instruction::create_account(
            buyer.key,
            vault.key,
            required_lamports,
            0,
            program_id
        );
        
        invoke_signed(
            &create_ix,
            &[
                buyer.clone(),
                vault.clone(),
                system_program.clone(),
            ],
            &[&[b"vault", escrow_account.key.as_ref(), &[vault_bump]]],
        )?;
    }

    escrow_data.save_to_account(escrow_account)?;
    msg!("Offer created with arbiter: {}", arbiter);
    msg!("State: Created");
    Ok(())
}

/// Seller joins offer (instruction_data: [1, seller(32 bytes)])
fn join_offer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() != 33 { 
        return Err(ProgramError::InvalidInstructionData);
    }
    
    let seller = Pubkey::new_from_array(instruction_data[1..33].try_into().unwrap());

    let accounts_iter = &mut accounts.iter();
    let seller_acc = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;

    if !seller_acc.is_signer {
        msg!("Seller must be signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    
    if escrow_data.get_state()? != EscrowState::Created {
        msg!("Offer must be in Created state");
        return Err(ProgramError::InvalidAccountData);
    }

    if escrow_data.seller != Pubkey::default() {
        msg!("Seller already set");
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    escrow_data.seller = seller;
    escrow_data.set_state(EscrowState::Initialized);
    escrow_data.save_to_account(escrow_account)?;
    msg!("Offer joined by seller: {}", seller);
    msg!("State: Initialized");
    Ok(())
}

/// Buyer funds the escrow
fn fund_escrow(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let buyer = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;

    if !buyer.is_signer {
        msg!("Buyer must be signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    if escrow_data.get_state()? != EscrowState::Initialized {
        msg!("Escrow must be in Initialized state");
        return Err(ProgramError::InvalidAccountData);
    }

    let seeds = &[b"vault", escrow_account.key.as_ref(), &[escrow_data.vault_bump]];
    let expected_vault = Pubkey::create_program_address(seeds, program_id)?;
    if expected_vault != *vault.key {
        msg!("Invalid vault PDA");
        return Err(ProgramError::InvalidSeeds);
    }

    invoke(
        &system_instruction::transfer(buyer.key, vault.key, escrow_data.amount),
        &[buyer.clone(), vault.clone(), system_program.clone()],
    )?;

    escrow_data.set_state(EscrowState::Funded);
    escrow_data.save_to_account(escrow_account)?;
    msg!("Escrow funded successfully. State: Funded");
    Ok(())
}

/// Seller confirms escrow, funds go to seller
fn confirm_escrow(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let seller = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;

    if !seller.is_signer {
        msg!("Seller must be signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    if escrow_data.get_state()? != EscrowState::Funded {
        msg!("Escrow must be in Funded state");
        return Err(ProgramError::InvalidAccountData);
    }

    if escrow_data.seller != *seller.key {
        msg!("Invalid seller");
        return Err(ProgramError::IllegalOwner);
    }

    **vault.try_borrow_mut_lamports()? -= escrow_data.amount;
    **seller.try_borrow_mut_lamports()? += escrow_data.amount;

    escrow_data.set_state(EscrowState::Completed);
    escrow_data.save_to_account(escrow_account)?;
    msg!("Escrow confirmed successfully");
    Ok(())
}

/// Arbiter confirms escrow, funds go to seller
fn arbiter_confirm(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let arbiter = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let seller = next_account_info(accounts_iter)?;

    if !arbiter.is_signer {
        msg!("Arbiter must be signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    
    if escrow_data.get_state()? != EscrowState::Funded {
        msg!("Escrow must be in Funded state");
        return Err(ProgramError::InvalidAccountData);
    }

    if escrow_data.seller != *seller.key {
        msg!("Invalid seller account");
        return Err(ProgramError::InvalidAccountData);
    }

    if escrow_data.arbiter != *arbiter.key {
        msg!("Invalid arbiter");
        return Err(ProgramError::IllegalOwner);
    }

    **vault.try_borrow_mut_lamports()? -= escrow_data.amount;
    **seller.try_borrow_mut_lamports()? += escrow_data.amount;

    escrow_data.set_state(EscrowState::Completed);
    escrow_data.save_to_account(escrow_account)?;
    msg!("Escrow completed by arbiter");
    Ok(())
}

/// Arbiter cancels escrow, funds return to buyer
fn arbiter_cancel(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let arbiter = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let buyer = next_account_info(accounts_iter)?;

    if !arbiter.is_signer {
        msg!("Arbiter must be signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    
    if escrow_data.get_state()? != EscrowState::Funded {
        msg!("Escrow must be in Funded state");
        return Err(ProgramError::InvalidAccountData);
    }

    if escrow_data.buyer != *buyer.key {
        msg!("Invalid buyer account");
        return Err(ProgramError::InvalidAccountData);
    }

    if escrow_data.arbiter != *arbiter.key {
        msg!("Invalid arbiter");
        return Err(ProgramError::IllegalOwner);
    }

    **vault.try_borrow_mut_lamports()? -= escrow_data.amount;
    **buyer.try_borrow_mut_lamports()? += escrow_data.amount;

    escrow_data.set_state(EscrowState::Cancelled);
    escrow_data.save_to_account(escrow_account)?;
    msg!("Escrow cancelled by arbiter");
    Ok(())
}

/// Buyer and seller mutually cancel escrow, funds return to buyer
fn mutual_cancel(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let buyer = next_account_info(accounts_iter)?;
    let seller = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;

    if !buyer.is_signer || !seller.is_signer {
        msg!("Both buyer and seller must sign");
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    
    let state = escrow_data.get_state()?;
    if state != EscrowState::Initialized && state != EscrowState::Funded {
        msg!("Escrow can only be cancelled in Initialized or Funded state");
        return Err(ProgramError::InvalidAccountData);
    }

    if escrow_data.buyer != *buyer.key {
        msg!("Invalid buyer account");
        return Err(ProgramError::InvalidAccountData);
    }
    
    if escrow_data.seller != *seller.key {
        msg!("Invalid seller account");
        return Err(ProgramError::InvalidAccountData);
    }

    if state == EscrowState::Funded {
        **vault.try_borrow_mut_lamports()? -= escrow_data.amount;
        **buyer.try_borrow_mut_lamports()? += escrow_data.amount;
    }

    escrow_data.set_state(EscrowState::Cancelled);
    escrow_data.save_to_account(escrow_account)?;
    msg!("Escrow mutually cancelled");
    Ok(())
}

/// Close escrow account, return rent to closer
fn close_escrow(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let closer = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;

    if !closer.is_signer {
        msg!("Closer must be signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    let escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    let state = escrow_data.get_state()?;
    
    if state != EscrowState::Completed && state != EscrowState::Cancelled {
        msg!("Escrow must be completed or cancelled");
        return Err(ProgramError::InvalidAccountData);
    }

    let valid_closer = *closer.key == escrow_data.buyer 
        || *closer.key == escrow_data.seller 
        || *closer.key == escrow_data.arbiter;
    
    if !valid_closer {
        msg!("Closer must be participant or arbiter");
        return Err(ProgramError::IllegalOwner);
    }

    let rent = Rent::get()?;
    let rent_exemption = rent.minimum_balance(escrow_account.data_len());
    let account_balance = escrow_account.lamports();
    
    if account_balance > rent_exemption {
        let refund = account_balance - rent_exemption;
        **escrow_account.try_borrow_mut_lamports()? -= refund;
        **closer.try_borrow_mut_lamports()? += refund;
    }

    let mut data = escrow_account.try_borrow_mut_data()?;
    data[0..EscrowAccount::LEN].fill(0);
    
    msg!("Escrow closed");
    Ok(())
}

/// Print escrow info to logs
fn get_escrow_info(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let escrow_account = next_account_info(accounts_iter)?;

    let escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    
    msg!("Escrow Information:");
    msg!("====================");
    msg!("State: {:?}", escrow_data.get_state()?);
    msg!("Amount: {} lamports", escrow_data.amount);
    msg!("Buyer: {}", escrow_data.buyer);
    msg!("Seller: {}", escrow_data.seller);
    msg!("Arbiter: {}", escrow_data.arbiter);
    msg!("Vault Bump: {}", escrow_data.vault_bump);
    msg!("====================");
    
    Ok(())
}