create table _yamanote_db_state (schemaVersion integer not null);
insert into
  _yamanote_db_state (schemaVersion)
values
  (2);
create table user (
  id INTEGER PRIMARY KEY,
  name text unique not null,
  hashed text not null,
  salt text not null,
  iterations integer not null,
  keylen integer not null,
  digest text not null
);
create table bookmark (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId integer not null,
  url text not null,
  title text not null,
  createdTime float not null,
  modifiedTime float not null,
  render text not null,
  renderedTime float not null,
  unique (url, title)
);
create table comment (
  id INTEGER PRIMARY KEY,
  bookmarkId integer not null,
  content text not null,
  createdTime float not null,
  modifiedTime float not null,
  render text not null,
  renderedTime float not null
);
create table backup (
  id INTEGER PRIMARY KEY,
  bookmarkId integer not null,
  content text not null,
  createdTime float not null
);
create table media (
  id INTEGER PRIMARY KEY,
  path text not null,
  -- url or filename
  mime text not null,
  -- TODO: allow same checksum, multiple filenames
  -- TODO: prevent users from seeing other users' media by knowing the id/checksum
  content blob not null,
  createdTime float not null,
  numBytes integer not null,
  unique (path, createdTime)
);
