pub mod flow_engine;
pub mod matcher;
pub mod models;
pub mod processors;

use redis::aio::MultiplexedConnection;
use sqlx::PgPool;

pub struct AppState {
    pub pool: PgPool,
    pub redis: MultiplexedConnection,
}
