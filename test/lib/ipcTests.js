/**
 * Copyright 2016-2017 F5 Networks, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const fs = require('fs');
const ipc = require('../../../f5-cloud-libs').ipc;
const util = require('../../../f5-cloud-libs').util;

const existsSync = fs.existsSync;
const closeSync = fs.closeSync;
const readdirSync = fs.readdirSync;

let counter;
const checkCounter = (expected, test) => {
    test.strictEqual(counter, expected);
    test.done();
};

module.exports = {
    setUp(callback) {
        counter = 0;
        callback();
    },

    tearDown(callback) {
        fs.readdirSync = readdirSync;
        fs.closeSync = closeSync;
        fs.existsSync = existsSync;
        ipc.clearSignals();
        util.removeDirectorySync(ipc.signalBasePath);
        callback();
    },

    testOnce: {
        testBasic(test) {
            ipc.once('foo')
                .then(() => {
                    counter += 1;
                });

            test.expect(2);
            test.strictEqual(counter, 0);
            ipc.send('foo');
            ipc.send('foo');
            setTimeout(checkCounter, 1100, 1, test);
        },

        testTwice(test) {
            ipc.once('foo')
                .then(() => {
                    counter += 1;
                });
            ipc.once('foo')
                .then(() => {
                    counter += 1;
                });

            test.expect(2);
            test.strictEqual(counter, 0);
            ipc.send('foo');
            ipc.send('foo');
            setTimeout(checkCounter, 1100, 2, test);
        },

        testError(test) {
            const message = 'existsSync error';
            fs.existsSync = () => {
                throw new Error(message);
            };

            // We have to both try/catch and then/catch because we see different
            // behavior in different environments
            try {
                ipc.once('foo')
                    .then(() => {
                        test.ok(false, 'once should have thrown');
                    })
                    .catch((err) => {
                        counter += 1;
                        test.strictEqual(err.message, message);
                    });
            } catch (err) {
                counter += 1;
                test.strictEqual(err.message, message);
            }

            test.expect(2);
            setTimeout(checkCounter, 1100, 1, test);
        }

    },

    testSend: {
        testBasic(test) {
            ipc.send('foo');
            test.strictEqual(fs.existsSync(`${ipc.signalBasePath}foo`), true);
            test.done();
        },

        testError(test) {
            const message = 'closeSync error';
            fs.closeSync = () => {
                throw new Error(message);
            };

            test.expect(1);
            try {
                ipc.send('foo');
                test.ok(false, 'send should have thrown');
            } catch (err) {
                test.strictEqual(err.message, message);
            } finally {
                test.done();
            }
        }
    },

    testClearSignals: {
        testBasic(test) {
            test.expect(2);
            ipc.send('foo');
            test.strictEqual(fs.existsSync('/tmp/f5-cloud-libs-signals/foo'), true);
            ipc.clearSignals();
            test.strictEqual(fs.existsSync('/tmp/f5-cloud-libs-signals/foo'), false);
            test.done();
        },

        testError(test) {
            const message = 'readdirSync error';
            fs.readdirSync = () => {
                throw new Error(message);
            };

            test.expect(1);
            try {
                ipc.clearSignals();
                test.ok(false, 'clearSignals should have thrown');
            } catch (err) {
                test.strictEqual(err.message, message);
            } finally {
                test.done();
            }
        }
    },

    testDirCreated: {
        setUp(callback) {
            if (fs.existsSync(ipc.signalBasePath)) {
                fs.rmdirSync(ipc.signalBasePath);
            }
            callback();
        },

        testOnSend(test) {
            ipc.send('foo');
            test.expect(1);
            test.strictEqual(fs.existsSync(ipc.signalBasePath), true);
            test.done();
        },

        testOnOnce(test) {
            ipc.once('foo');
            test.expect(1);
            test.strictEqual(fs.existsSync(ipc.signalBasePath), true);
            test.done();
        }
    },

    testSetLogger(test) {
        test.expect(1);
        test.doesNotThrow(() => {
            ipc.setLogger({});
        });
        test.done();
    },

    testSetLoggerOptions(test) {
        test.expect(1);
        test.doesNotThrow(() => {
            ipc.setLoggerOptions({});
        });
        test.done();
    }
};
