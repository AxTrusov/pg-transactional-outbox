# Change Log

All notable changes to the pg-transactional-outbox library will be documented in
this file.

## [0.2.0] - 2023-10-26

### Changed

- BREAKING CHANGE: renamed "event type" to "message type" in the library and in
  the database columns. This was done to better transport the meaning that the
  transactional inbox and outbox can be used both for commands and events and
  not just for events. Please rename for your inbox and outbox table the
  `event_type` column to `message_type`. And in your code the message
  `eventType` field with `messageType`.

### Added

- The function `initializeGeneralOutboxMessageStorage` can now be used for a
  general outbox storage function that does not encapsulate the settings to
  store a specific message and aggregate type.

## [0.1.8] - 2023-09-22

### Changed

- Fixed an issue where "this" was not correctly bound when executing message
  handlers when they are provided as object methods.

## [0.1.7] - 2023-09-18

### Changed

- Improved published package contents to exclude unit test files.

## [0.1.6] - 2023-09-15

### Changed

- The logical replication service will now guarantee sequential message
  processing in the order how the messages were received. So far the messages
  were only started in the desired order but could finish in different order
  depending how long the message handler ran.

### Added

- Only one service can connect to the publication of a replication slot. When
  services are scaled, the first one will succeed to connect but the others will
  fail. There is now a new setting `restartDelaySlotInUse` to define the delay
  before trying to connect again if the replication slot is in use.

## [0.1.5] - 2023-09-11

### Added

- Debug log for replication start added. This way the actual start of the
  service and restarts can be tracked.

## [0.1.4] - 2023-05-15

### Changed

- Fixed an issue where messages were sometimes processed even after the maximum
  message retry for the inbox message was exceeded.

## [0.1.1 - 0.1.3] - 2023-01-28

### Changed

- Updated the readme files and referenced images.

## [0.1.0] - 2023-01-28

### Added

- Initial version of the library.
