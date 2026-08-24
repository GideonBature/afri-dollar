extern crate std;

use crate::{OracleContract, OracleContractClient, OracleError, PriceSubmitted, ProviderEvent};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, Ledger},
    xdr::ContractEvent,
    Address, Env, Event,
};

const STALENESS: u64 = 60;
const DECIMALS: u32 = 7;
const T0: u64 = 1_000;

struct Fixture {
    contract_id: Address,
    admin: Address,
}

fn setup() -> (Env, Fixture) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let admin = Address::generate(&env);
    let contract_id = env.register(OracleContract, ());
    let client = OracleContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    (env, Fixture { contract_id, admin })
}

fn client<'a>(env: &'a Env, f: &Fixture) -> OracleContractClient<'a> {
    OracleContractClient::new(env, &f.contract_id)
}

fn assets(env: &Env) -> (Address, Address) {
    let a = Address::generate(env);
    let b = Address::generate(env);
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

fn register_provider(env: &Env, f: &Fixture, max_staleness: u64) -> Address {
    let provider = Address::generate(env);
    client(env, f).register_provider(&f.admin, &provider, &max_staleness);
    provider
}

fn register_authorized(env: &Env, f: &Fixture, max_staleness: u64) -> Address {
    let provider = register_provider(env, f, max_staleness);
    client(env, f).authorize_provider(&f.admin, &provider);
    provider
}

fn set_time(env: &Env, t: u64) {
    env.ledger().set_timestamp(t);
}

fn snapshot_contract_events(env: &Env, f: &Fixture) -> std::vec::Vec<ContractEvent> {
    env.events()
        .all()
        .filter_by_contract(&f.contract_id)
        .events()
        .to_vec()
}

/// Events from the operation under test.
///
/// `Env::events().all()` currently returns only the latest invocation; if the
/// host instead accumulates, this is the suffix after `before`.
fn events_from_op<'a>(before: &[ContractEvent], after: &'a [ContractEvent]) -> &'a [ContractEvent] {
    if after.starts_with(before) {
        &after[before.len()..]
    } else {
        after
    }
}

fn assert_new_event(env: &Env, f: &Fixture, before: &[ContractEvent], expected: ContractEvent) {
    let after = env.events().all().filter_by_contract(&f.contract_id);
    assert_eq!(
        events_from_op(before, after.events()),
        std::slice::from_ref(&expected)
    );
}

fn assert_provider_event(
    env: &Env,
    f: &Fixture,
    before: &[ContractEvent],
    action: soroban_sdk::Symbol,
    provider: &Address,
    authorized: bool,
    max_staleness_seconds: u64,
) {
    let expected = ProviderEvent {
        action,
        provider: provider.clone(),
        authorized,
        max_staleness_seconds,
    }
    .to_xdr(env, &f.contract_id);
    assert_new_event(env, f, before, expected);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

#[test]
fn initialize_once_ok() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(OracleContract, ());
    let client = OracleContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let unknown = Address::generate(&env);
    assert_eq!(
        client.try_get_provider(&unknown),
        Err(Ok(OracleError::ProviderNotRegistered))
    );
}

#[test]
fn initialize_twice_already_initialized() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let result = c.try_initialize(&f.admin);
    assert_eq!(result, Err(Ok(OracleError::AlreadyInitialized)));
}

#[test]
fn register_provider_requires_admin() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider = Address::generate(&env);
    let before = snapshot_contract_events(&env, &f);
    c.register_provider(&f.admin, &provider, &STALENESS);
    assert_provider_event(
        &env,
        &f,
        &before,
        symbol_short!("reg"),
        &provider,
        false,
        STALENESS,
    );

    let cfg = c.get_provider(&provider);
    assert_eq!(cfg.provider, provider);
    assert!(!cfg.authorized);
    assert_eq!(cfg.last_heartbeat, T0);
    assert_eq!(cfg.max_staleness_seconds, STALENESS);
    assert!(!c.is_provider_active(&provider));
}

#[test]
fn authorize_revoke_roundtrip() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider = register_provider(&env, &f, STALENESS);

    let before = snapshot_contract_events(&env, &f);
    c.authorize_provider(&f.admin, &provider);
    assert_provider_event(
        &env,
        &f,
        &before,
        symbol_short!("auth"),
        &provider,
        true,
        STALENESS,
    );
    assert!(c.get_provider(&provider).authorized);
    assert!(c.is_provider_active(&provider));

    let before = snapshot_contract_events(&env, &f);
    c.revoke_provider(&f.admin, &provider);
    assert_provider_event(
        &env,
        &f,
        &before,
        symbol_short!("revoke"),
        &provider,
        false,
        STALENESS,
    );
    assert!(!c.get_provider(&provider).authorized);
    assert!(!c.is_provider_active(&provider));
}

#[test]
fn heartbeat_updates_last_heartbeat_staleness_window() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider = register_authorized(&env, &f, STALENESS);
    assert_eq!(c.get_provider(&provider).last_heartbeat, T0);

    set_time(&env, T0 + 50);
    assert!(c.is_provider_active(&provider));

    set_time(&env, T0 + STALENESS + 1);
    assert!(!c.is_provider_active(&provider));

    let before = snapshot_contract_events(&env, &f);
    c.heartbeat(&provider);
    assert_provider_event(
        &env,
        &f,
        &before,
        symbol_short!("beat"),
        &provider,
        true,
        STALENESS,
    );
    let cfg = c.get_provider(&provider);
    assert_eq!(cfg.last_heartbeat, T0 + STALENESS + 1);
    assert!(c.is_provider_active(&provider));
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

#[test]
fn submit_price_requires_auth() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider = register_authorized(&env, &f, STALENESS);
    let (asset_a, asset_b) = assets(&env);

    env.set_auths(&[]);
    let result = c.try_submit_price(&provider, &asset_a, &asset_b, &100, &DECIMALS);
    assert!(result.is_err());
}

#[test]
fn submit_price_stores_and_emits_event() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider = register_authorized(&env, &f, STALENESS);
    let (asset_a, asset_b) = assets(&env);

    let before = snapshot_contract_events(&env, &f);
    c.submit_price(&provider, &asset_a, &asset_b, &1_000_000, &DECIMALS);

    let expected = PriceSubmitted {
        provider: provider.clone(),
        asset_a: asset_a.clone(),
        asset_b: asset_b.clone(),
        price: 1_000_000,
        decimals: DECIMALS,
        timestamp: T0,
    }
    .to_xdr(&env, &f.contract_id);
    assert_new_event(&env, &f, &before, expected);

    let price = c.get_price(&asset_a, &asset_b);
    assert_eq!(price.asset_a, asset_a);
    assert_eq!(price.asset_b, asset_b);
    assert_eq!(price.price, 1_000_000);
    assert_eq!(price.decimals, DECIMALS);
    assert_eq!(price.timestamp, T0);
    assert_eq!(price.provider, provider);
}

#[test]
fn submit_price_invalid_amount_rejected() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider = register_authorized(&env, &f, STALENESS);
    let (asset_a, asset_b) = assets(&env);

    assert_eq!(
        c.try_submit_price(&provider, &asset_a, &asset_b, &0, &DECIMALS),
        Err(Ok(OracleError::InvalidPrice))
    );
    assert_eq!(
        c.try_submit_price(&provider, &asset_a, &asset_b, &-1, &DECIMALS),
        Err(Ok(OracleError::InvalidPrice))
    );
}

// ---------------------------------------------------------------------------
// Price reads
// ---------------------------------------------------------------------------

#[test]
fn get_price_newest_active_provider_wins() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider_a = register_authorized(&env, &f, STALENESS);
    let provider_b = register_authorized(&env, &f, STALENESS);
    let (asset_a, asset_b) = assets(&env);

    c.submit_price(&provider_a, &asset_a, &asset_b, &100, &DECIMALS);
    set_time(&env, T0 + 10);
    c.heartbeat(&provider_a);
    c.heartbeat(&provider_b);
    c.submit_price(&provider_b, &asset_a, &asset_b, &200, &DECIMALS);

    let price = c.get_price(&asset_a, &asset_b);
    assert_eq!(price.price, 200);
    assert_eq!(price.provider, provider_b);
    assert_eq!(price.timestamp, T0 + 10);
}

#[test]
fn get_price_stale_provider_excluded() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider_a = register_authorized(&env, &f, STALENESS);
    let provider_b = register_authorized(&env, &f, STALENESS);
    let (asset_a, asset_b) = assets(&env);

    c.submit_price(&provider_a, &asset_a, &asset_b, &100, &DECIMALS);

    set_time(&env, T0 + 30);
    c.heartbeat(&provider_a);
    c.heartbeat(&provider_b);
    c.submit_price(&provider_b, &asset_a, &asset_b, &200, &DECIMALS);

    set_time(&env, T0 + 70);
    c.heartbeat(&provider_a);
    c.heartbeat(&provider_b);

    let price = c.get_price(&asset_a, &asset_b);
    assert_eq!(price.price, 200);
    assert_eq!(price.provider, provider_b);
}

#[test]
fn get_price_no_active_providers_not_found() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let (asset_a, asset_b) = assets(&env);
    let provider = register_authorized(&env, &f, STALENESS);
    c.submit_price(&provider, &asset_a, &asset_b, &100, &DECIMALS);

    set_time(&env, T0 + STALENESS + 1);
    assert!(!c.is_provider_active(&provider));
    assert_eq!(
        c.try_get_price(&asset_a, &asset_b),
        Err(Ok(OracleError::PriceNotFound))
    );
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

#[test]
fn aggregated_2providers_mean_matches_rounded_integer() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider_a = register_authorized(&env, &f, STALENESS);
    let provider_b = register_authorized(&env, &f, STALENESS);
    let (asset_a, asset_b) = assets(&env);

    c.submit_price(&provider_a, &asset_a, &asset_b, &10, &DECIMALS);
    set_time(&env, T0 + 5);
    c.heartbeat(&provider_a);
    c.heartbeat(&provider_b);
    c.submit_price(&provider_b, &asset_a, &asset_b, &21, &DECIMALS);

    let agg = c.get_aggregated_price(&asset_a, &asset_b);
    // Mean is integer division truncated toward zero: (10 + 21) / 2 = 15.
    assert_eq!(agg.price, (10 + 21) / 2);
    assert_eq!(agg.decimals, DECIMALS);
    assert_eq!(agg.timestamp, T0 + 5);
    assert_eq!(agg.provider, provider_b);
}

#[test]
fn aggregated_stale_mixed_only_fresh_counted() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider_a = register_authorized(&env, &f, STALENESS);
    let provider_b = register_authorized(&env, &f, STALENESS);
    let (asset_a, asset_b) = assets(&env);

    c.submit_price(&provider_a, &asset_a, &asset_b, &100, &DECIMALS);

    set_time(&env, T0 + 30);
    c.heartbeat(&provider_a);
    c.heartbeat(&provider_b);
    c.submit_price(&provider_b, &asset_a, &asset_b, &200, &DECIMALS);

    set_time(&env, T0 + 70);
    c.heartbeat(&provider_a);
    c.heartbeat(&provider_b);

    let agg = c.get_aggregated_price(&asset_a, &asset_b);
    assert_eq!(agg.price, 200);
    assert_eq!(agg.provider, provider_b);
}

#[test]
fn aggregated_decimal_mismatch_rejected() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider_a = register_authorized(&env, &f, STALENESS);
    let provider_b = register_authorized(&env, &f, STALENESS);
    let (asset_a, asset_b) = assets(&env);

    c.submit_price(&provider_a, &asset_a, &asset_b, &100, &7);
    c.submit_price(&provider_b, &asset_a, &asset_b, &200, &8);

    assert_eq!(
        c.try_get_aggregated_price(&asset_a, &asset_b),
        Err(Ok(OracleError::DecimalMismatch))
    );
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

#[test]
fn register_provider_non_admin_unauthorized() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let stranger = Address::generate(&env);
    let provider = Address::generate(&env);

    let result = c.try_register_provider(&stranger, &provider, &STALENESS);
    assert_eq!(result, Err(Ok(OracleError::Unauthorized)));
    assert_eq!(
        c.try_get_provider(&provider),
        Err(Ok(OracleError::ProviderNotRegistered))
    );
}

#[test]
fn submit_price_unauthorized_provider_rejected() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider = register_provider(&env, &f, STALENESS);
    let (asset_a, asset_b) = assets(&env);

    assert!(!c.get_provider(&provider).authorized);
    assert_eq!(
        c.try_submit_price(&provider, &asset_a, &asset_b, &100, &DECIMALS),
        Err(Ok(OracleError::Unauthorized))
    );
    assert_eq!(
        c.try_get_price(&asset_a, &asset_b),
        Err(Ok(OracleError::PriceNotFound))
    );
}

#[test]
fn authorize_provider_non_admin_unauthorized() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider = register_provider(&env, &f, STALENESS);
    let stranger = Address::generate(&env);

    assert_eq!(
        c.try_authorize_provider(&stranger, &provider),
        Err(Ok(OracleError::Unauthorized))
    );
    assert!(!c.get_provider(&provider).authorized);
}

#[test]
fn revoke_provider_non_admin_unauthorized() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider = register_authorized(&env, &f, STALENESS);
    let stranger = Address::generate(&env);

    assert_eq!(
        c.try_revoke_provider(&stranger, &provider),
        Err(Ok(OracleError::Unauthorized))
    );
    assert!(c.get_provider(&provider).authorized);
}

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

#[test]
fn provider_inactive_no_heartbeat_returns_inactive_flag() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider = register_authorized(&env, &f, STALENESS);
    let (asset_a, asset_b) = assets(&env);
    c.submit_price(&provider, &asset_a, &asset_b, &100, &DECIMALS);

    set_time(&env, T0 + STALENESS + 1);
    assert!(!c.is_provider_active(&provider));
    assert_eq!(
        c.try_submit_price(&provider, &asset_a, &asset_b, &200, &DECIMALS),
        Err(Ok(OracleError::ProviderInactive))
    );
}

#[test]
fn get_aggregated_price_zero_count_price_not_found() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let (asset_a, asset_b) = assets(&env);
    let _provider = register_authorized(&env, &f, STALENESS);

    assert_eq!(
        c.try_get_aggregated_price(&asset_a, &asset_b),
        Err(Ok(OracleError::PriceNotFound))
    );
}

#[test]
fn register_provider_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(OracleContract, ());
    let c = OracleContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let provider = Address::generate(&env);

    assert_eq!(
        c.try_register_provider(&admin, &provider, &STALENESS),
        Err(Ok(OracleError::NotInitialized))
    );
}

#[test]
fn register_provider_already_registered() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider = register_provider(&env, &f, STALENESS);

    assert_eq!(
        c.try_register_provider(&f.admin, &provider, &STALENESS),
        Err(Ok(OracleError::ProviderAlreadyRegistered))
    );
}

#[test]
fn authorize_provider_not_registered() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let unknown = Address::generate(&env);

    assert_eq!(
        c.try_authorize_provider(&f.admin, &unknown),
        Err(Ok(OracleError::ProviderNotRegistered))
    );
}

#[test]
fn heartbeat_provider_not_registered() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let unknown = Address::generate(&env);

    assert_eq!(
        c.try_heartbeat(&unknown),
        Err(Ok(OracleError::ProviderNotRegistered))
    );
}

#[test]
fn get_price_canonical_pair_order_independent() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider = register_authorized(&env, &f, STALENESS);
    let (asset_a, asset_b) = assets(&env);

    c.submit_price(&provider, &asset_b, &asset_a, &100, &DECIMALS);

    let forward = c.get_price(&asset_a, &asset_b);
    let reverse = c.get_price(&asset_b, &asset_a);
    assert_eq!(forward, reverse);
    assert_eq!(forward.asset_a, asset_a);
    assert_eq!(forward.asset_b, asset_b);
    assert_eq!(forward.price, 100);
}

#[test]
fn get_price_very_old_timestamp_excluded() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider = register_authorized(&env, &f, STALENESS);
    let (asset_a, asset_b) = assets(&env);
    c.submit_price(&provider, &asset_a, &asset_b, &100, &DECIMALS);

    set_time(&env, T0 + 10_000);
    c.heartbeat(&provider);
    assert!(c.is_provider_active(&provider));
    assert_eq!(
        c.try_get_price(&asset_a, &asset_b),
        Err(Ok(OracleError::PriceNotFound))
    );
}

#[test]
fn aggregated_overflow_rejected() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider_a = register_authorized(&env, &f, STALENESS);
    let provider_b = register_authorized(&env, &f, STALENESS);
    let (asset_a, asset_b) = assets(&env);

    c.submit_price(&provider_a, &asset_a, &asset_b, &i128::MAX, &DECIMALS);
    c.submit_price(&provider_b, &asset_a, &asset_b, &1, &DECIMALS);

    assert_eq!(
        c.try_get_aggregated_price(&asset_a, &asset_b),
        Err(Ok(OracleError::Overflow))
    );
}

#[test]
fn heartbeat_without_authorize_stays_inactive() {
    let (env, f) = setup();
    let c = client(&env, &f);
    let provider = register_provider(&env, &f, STALENESS);

    set_time(&env, T0 + STALENESS + 1);
    c.heartbeat(&provider);
    assert_eq!(c.get_provider(&provider).last_heartbeat, T0 + STALENESS + 1);
    assert!(!c.is_provider_active(&provider));
}
