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
    Uninitialized = 0,   // Account not initialized
    Created = 1,        // Offer created, only one party set
    Initialized = 2,    // Both parties set, ready to fund
    Funded = 3,         // Buyer funded escrow
    SellerConfirmed = 4,// Seller confirmed fulfillment
    BuyerConfirmed = 5, // (Unused, for future extension)
    Completed = 6,      // Funds released to seller
    Cancelled = 7,      // Escrow cancelled
}

#[repr(C)]
#[derive(Debug)]
/// Main escrow account data structure
pub struct EscrowAccount {
    buyer: Pubkey,       // Buyer's public key
    seller: Pubkey,      // Seller's public key
    arbiter: Pubkey,     // Arbiter's public key
    amount: u64,         // Amount in lamports
    state: u8,           // Current state (EscrowState)
    vault_bump: u8,      // PDA bump for vault
}

impl EscrowAccount {
    const LEN: usize = 32 + 32 + 32 + 8 + 1 + 1; // Size of account data

    /// Create a new escrow account instance
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
    
    /// Deserialize account data into EscrowAccount
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
    
    /// Serialize EscrowAccount into account data
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
    
    /// Get the current state as EscrowState enum
    fn get_state(&self) -> Result<EscrowState, ProgramError> {
        match self.state {
            0 => Ok(EscrowState::Uninitialized),
            1 => Ok(EscrowState::Created),
            2 => Ok(EscrowState::Initialized),
            3 => Ok(EscrowState::Funded),
            4 => Ok(EscrowState::SellerConfirmed),
            5 => Ok(EscrowState::BuyerConfirmed),
            6 => Ok(EscrowState::Completed),
            7 => Ok(EscrowState::Cancelled),
            _ => {
                msg!("Invalid escrow state: {}", self.state);
                Err(ProgramError::InvalidAccountData)
            }
        }
    }
    
    /// Set the current state
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
        9 => seller_confirm(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Instruction 0: Create offer
/// Accounts:
///   [signer] initiator (buyer or seller)
///   [writable] escrow_account (PDA)
///   [writable] vault (PDA)
///   [] system_program
/// instruction_data: [0, role(1 byte), amount(8 bytes), arbiter(32 bytes)]
/// role: 0 = buyer creates, 1 = seller creates
fn create_offer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() != 42 { // 1 + 1 + 8 + 32
        msg!("Invalid instruction data length");
        return Err(ProgramError::InvalidInstructionData);
    }
    
    let role = instruction_data[1];
    let amount = u64::from_le_bytes(instruction_data[2..10].try_into().unwrap());
    let arbiter = Pubkey::new_from_array(instruction_data[10..42].try_into().unwrap());

    let accounts_iter = &mut accounts.iter();
    let initiator = next_account_info(accounts_iter)?; // Buyer or seller
    let escrow_account = next_account_info(accounts_iter)?; // Escrow PDA
    let vault = next_account_info(accounts_iter)?; // Vault PDA
    let system_program = next_account_info(accounts_iter)?;

    if !initiator.is_signer {
        msg!("Initiator must be signer");
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

    // Set roles based on who creates the offer
    let (buyer, seller) = if role == 0 {
        (*initiator.key, Pubkey::default()) // Initiator is buyer
    } else {
        (Pubkey::default(), *initiator.key) // Initiator is seller
    };

    let escrow_data = EscrowAccount {
        buyer,
        seller,
        arbiter,
        amount,
        state: EscrowState::Created as u8,
        vault_bump,
    };
    
    let rent = Rent::get()?;
    let required_lamports = rent.minimum_balance(0); 
    
    // Create vault account if not exists
    if vault.lamports() == 0 {
        let create_ix = system_instruction::create_account(
            initiator.key,
            vault.key,
            required_lamports,
            0,
            program_id
        );
        
        invoke_signed(
            &create_ix,
            &[
                initiator.clone(),
                vault.clone(),
                system_program.clone(),
            ],
            &[&[b"vault", escrow_account.key.as_ref(), &[vault_bump]]],
        )?;
    }

    escrow_data.save_to_account(escrow_account)?;
    msg!("Offer created with arbiter: {}", arbiter);
    msg!("Initiator role: {}", if role == 0 { "buyer" } else { "seller" });
    msg!("State: Created");
    Ok(())
}

/// Instruction 1: Second party joins offer
/// Accounts:
///   [signer] joiner (buyer or seller)
///   [writable] escrow_account (PDA)
/// instruction_data: [1, role(1 byte), joiner(32 bytes)]
/// role: 0 = buyer joins, 1 = seller joins
fn join_offer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() != 34 { // 1 + 1 + 32
        return Err(ProgramError::InvalidInstructionData);
    }
    
    let role = instruction_data[1];
    let joiner = Pubkey::new_from_array(instruction_data[2..34].try_into().unwrap());

    let accounts_iter = &mut accounts.iter();
    let joiner_acc = next_account_info(accounts_iter)?; // Buyer or seller
    let escrow_account = next_account_info(accounts_iter)?; // Escrow PDA

    if !joiner_acc.is_signer {
        msg!("Joiner must be signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    
    if escrow_data.get_state()? != EscrowState::Created {
        msg!("Offer must be in Created state");
        return Err(ProgramError::InvalidAccountData);
    }

    // Set the missing role
    if role == 0 {
        // Joiner is buyer
        if escrow_data.buyer != Pubkey::default() {
            msg!("Buyer already set");
            return Err(ProgramError::AccountAlreadyInitialized);
        }
        escrow_data.buyer = joiner;
    } else {
        // Joiner is seller
        if escrow_data.seller != Pubkey::default() {
            msg!("Seller already set");
            return Err(ProgramError::AccountAlreadyInitialized);
        }
        escrow_data.seller = joiner;
    }

    escrow_data.set_state(EscrowState::Initialized);
    escrow_data.save_to_account(escrow_account)?;
    msg!("Offer joined by {}: {}", if role == 0 { "buyer" } else { "seller" }, joiner);
    msg!("State: Initialized");
    Ok(())
}

/// Instruction 2: Buyer funds the escrow
/// Accounts:
///   [signer] buyer
///   [writable] escrow_account (PDA)
///   [writable] vault (PDA)
///   [] system_program
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

    // Transfer funds from buyer to vault
    invoke(
        &system_instruction::transfer(buyer.key, vault.key, escrow_data.amount),
        &[buyer.clone(), vault.clone(), system_program.clone()],
    )?;

    escrow_data.set_state(EscrowState::Funded);
    escrow_data.save_to_account(escrow_account)?;
    msg!("Escrow funded successfully. State: Funded");
    Ok(())
}

/// Instruction 9: Seller confirms fulfillment
/// Accounts:
///   [signer] seller
///   [writable] escrow_account (PDA)
fn seller_confirm(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let seller = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;

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
    escrow_data.set_state(EscrowState::SellerConfirmed);
    escrow_data.save_to_account(escrow_account)?;
    msg!("Seller confirmed fulfillment. State: SellerConfirmed");
    Ok(())
}

/// Instruction 3: Buyer confirms escrow, funds go to seller (only after seller_confirm)
/// Accounts:
///   [signer] buyer
///   [writable] escrow_account (PDA)
///   [writable] vault (PDA)
///   [] system_program
///   [writable] seller_account
fn confirm_escrow(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let buyer = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;
    let seller_account = next_account_info(accounts_iter)?;

    if !buyer.is_signer {
        msg!("Buyer must be signer");
        return Err(ProgramError::MissingRequiredSignature);
    }
    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    if escrow_data.get_state()? != EscrowState::SellerConfirmed {
        msg!("Escrow must be in SellerConfirmed state");
        return Err(ProgramError::InvalidAccountData);
    }
    if escrow_data.buyer != *buyer.key {
        msg!("Invalid buyer");
        return Err(ProgramError::IllegalOwner);
    }
    let seller = escrow_data.seller;
    if seller == Pubkey::default() {
        msg!("Seller not set");
        return Err(ProgramError::UninitializedAccount);
    }
    if seller_account.key != &seller {
        msg!("Invalid seller account");
        return Err(ProgramError::InvalidAccountData);
    }
    // Transfer funds from vault to seller
    **vault.try_borrow_mut_lamports()? -= escrow_data.amount;
    **seller_account.try_borrow_mut_lamports()? += escrow_data.amount;
    escrow_data.set_state(EscrowState::Completed);
    escrow_data.save_to_account(escrow_account)?;
    msg!("Escrow confirmed by buyer. Funds released to seller. State: Completed");
    Ok(())
}

/// Instruction 4: Arbiter confirms escrow, funds go to seller (can be called in Funded or SellerConfirmed)
/// Accounts:
///   [signer] arbiter
///   [writable] escrow_account (PDA)
///   [writable] vault (PDA)
///   [writable] seller_account
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
    let state = escrow_data.get_state()?;
    if state != EscrowState::Funded && state != EscrowState::SellerConfirmed {
        msg!("Escrow must be in Funded or SellerConfirmed state");
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
    // Transfer funds from vault to seller
    **vault.try_borrow_mut_lamports()? -= escrow_data.amount;
    **seller.try_borrow_mut_lamports()? += escrow_data.amount;
    escrow_data.set_state(EscrowState::Completed);
    escrow_data.save_to_account(escrow_account)?;
    msg!("Escrow completed by arbiter");
    Ok(())
}

/// Instruction 5: Arbiter cancels escrow, funds return to buyer (can be called in Funded or SellerConfirmed)
/// Accounts:
///   [signer] arbiter
///   [writable] escrow_account (PDA)
///   [writable] vault (PDA)
///   [writable] buyer_account
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
    let state = escrow_data.get_state()?;
    if state != EscrowState::Funded && state != EscrowState::SellerConfirmed {
        msg!("Escrow must be in Funded or SellerConfirmed state");
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
    // Transfer funds from vault to buyer
    **vault.try_borrow_mut_lamports()? -= escrow_data.amount;
    **buyer.try_borrow_mut_lamports()? += escrow_data.amount;
    escrow_data.set_state(EscrowState::Cancelled);
    escrow_data.save_to_account(escrow_account)?;
    msg!("Escrow cancelled by arbiter");
    Ok(())
}

/// Instruction 8: Buyer and seller mutually cancel escrow, funds return to buyer
/// Accounts:
///   [signer] buyer
///   [signer] seller
///   [writable] escrow_account (PDA)
///   [writable] vault (PDA)
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

    // If funded, return funds to buyer
    if state == EscrowState::Funded {
        **vault.try_borrow_mut_lamports()? -= escrow_data.amount;
        **buyer.try_borrow_mut_lamports()? += escrow_data.amount;
    }

    escrow_data.set_state(EscrowState::Cancelled);
    escrow_data.save_to_account(escrow_account)?;
    msg!("Escrow mutually cancelled");
    Ok(())
}

/// Instruction 6: Close escrow account, return rent to closer
/// Accounts:
///   [signer] closer (buyer, seller, or arbiter)
///   [writable] escrow_account (PDA)
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

/// Instruction 7: Print escrow info to logs
/// Accounts:
///   [writable] escrow_account (PDA)
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