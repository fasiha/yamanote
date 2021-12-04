create table _yamanote_db_state (schemaVersion integer not null);
insert into
  _yamanote_db_state (schemaVersion)
values
  (4);
create table user (
  id INTEGER PRIMARY KEY,
  displayName text not null,
  githubId integer unique not null
);
create table token (
  token text primary key not null,
  description text not null,
  userId integer not null
);
create table bookmark (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId integer not null,
  url text not null,
  title text not null,
  createdTime float not null,
  modifiedTime float not null,
  numComments integer not null,
  render text not null,
  renderedTime float not null,
  unique (url, title, userId)
);
create table comment (
  id INTEGER PRIMARY KEY,
  bookmarkId integer not null,
  siblingIdx integer not null,
  content text not null,
  createdTime float not null,
  modifiedTime float not null,
  innerRender text not null,
  fullRender text not null,
  renderedTime float not null
);
create table backup (
  id INTEGER PRIMARY KEY,
  bookmarkId integer not null,
  content text not null,
  original text not null,
  createdTime float not null
);
-- a path that points to a hash
create table media (
  id INTEGER PRIMARY KEY,
  -- url or filename
  path text not null,
  bookmarkId integer not null,
  sha256 text not null, 
  createdTime float not null,
  unique (sha256, path, bookmarkId)
);
create table blob (
  id INTEGER PRIMARY KEY,
  content blob not null,
  mime text not null,
  createdTime float not null,
  numBytes integer not null,
  sha256 text unique not null
)