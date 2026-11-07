// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// Every error thrown by S2JS carries a human readable `reason` you can show to users.

const formatError = (reason) => Object.assign(new Error(reason), { reason });

const fail = (reason) => {
  throw formatError(reason);
};

export { formatError, fail };
