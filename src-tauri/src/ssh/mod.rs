//! SSH 연결 관리. russh 단일 스택 (시스템 ssh 호출 금지 — CLAUDE.md §9).

pub mod config;
pub mod connection;
pub mod remote_exec;
