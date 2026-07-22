create table participants (
    participant_id uuid primary key,
    session_id uuid not null
        references sessions(session_id) on delete cascade,

    display_name text not null,
    normalized_display_name text not null,

    participant_token text not null unique,

    joined_at timestamptz not null default now()
);

create unique index participants_session_display_name_unique
on participants (
    session_id,
    normalized_display_name
);