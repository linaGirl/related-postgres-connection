const log = require('ee-log');
const pg = require('pg');
const RelatedError = require('related-error');
const type = require('ee-types');
const Connection = require('related-db-connection');
const QueryContext = require('related-query-context');




// tell the driver to use sane deafults
// see https://github.com/brianc/node-postgres/pull/714
pg.defaults.database = '';





module.exports = class PsotgresConnection extends Connection {

    // brand name used for logging
    brand ='POSTGRES';


    /*
    * LOCK_READ:        NOT IMPLEMENTED
    * LOCK_WRITE:       SHARE ROW EXCLUSIVE -> This mode protects a table against concurrent data changes, only one session can hold it at a time.
    * LOCK_EXCLUSIVE:   ACCESS EXCLUSIVE -> This mode guarantees that the holder is the only transaction accessing the table in any way
    */
    lockModes = {
        LOCK_WRITE: 'SHARE ROW EXCLUSIVE',
        LOCK_EXCLUSIVE: 'ACCESS EXCLUSIVE',
    }




    /**
     * the _connect() method creates the database connection
     *
     * @param <Function> done callback
     */
    driverConnect(config, callback) {

        if (!config.port) config.port = 5432;
        if (!config.username) config.username = 'postgres';


        this.connection = new pg.Client({
                user        : config.username
            , password    : config.password
            , host        : config.host
            , port        : config.port
            , database    : config.database
        });



        // connect
        this.connection.connect((err) => {
            if (err) {
                if (err.code === '28P01') err = new RelatedError.InvalidCredentialsError(err);
                else if (err.code === 'ECONNREFUSED') err = new RelatedError.FailedToConnectError(err);
                else if (err.code === 'ENETUNREACH') err = new RelatedError.FailedToConnectError(err);
                else if (err.code === 'ECONNRESET') err = new RelatedError.FailedToConnectError(err);
                else if (err.code === 'EHOSTUNREACH') err = new RelatedError.FailedToConnectError(err);
            }

            callback(err);
        });


        // remove dead connections from the pool
        this.connection.on('error', (err) => {

            if (err.code === 'ECONNREFUSED') err = new RelatedError.FailedToConnectError(err);
            else if (err.code === 'ENETUNREACH') err = new RelatedError.FailedToConnectError(err);
            else if (err.code === 'ECONNRESET') err = new RelatedError.FailedToConnectError(err);
            else if (err.code === 'EHOSTUNREACH') err = new RelatedError.FailedToConnectError(err);

            // since the conenciton probably ended 
            // anyway we are going to kill it off
            this.connection.end();
            delete this.connection;

            // emit the error event, its used by super
            // to inddicate theat no query is running 
            // anymore
            this.emit('error', err);

            // call the super end method
            this.end(err);
        });
    }







    /**
     * ends the connection
     */
    endConnection(callback) {
        this.connection.once('end', callback);
        this.connection.end();
    }






    /*
        * set a lock on a tblae
        */
    lock(schema, table, lockType, callback) {
        if (!this.lockModes[lockType]) callback(Error('Invalid or not supported lock type «'+lockType+'»!'));
        else {
            this.query('LOCK TABLE '+(schema? this.escapeId(schema)+'.': '')+this.escapeId(table)+' IN '+this.lockModes[lockType]+' MODE;').then((data) => {
                callback(null, data);
            }).catch(callback);
        }
    }







    /**
     * the _escape() securely escapes values preventing sql injection
     *
     * @param <String> input
     */
    escape(input) {
        return this.connection.escapeLiteral(input+'');
    }




    /**
     * the _escapeId() method escapes a name so it doesnt collide with
     * reserved keywords
     *
     * @param <String> input
     */
    escapeId(input) {
        if (!type.string(input) || !input.length) throw new Error('Cannot escape id «'+input+'»!');

        return this.connection.escapeIdentifier(input);
    }






    /**
     * the _query() method send a query to the rdbms
     *
     * @param <Object> query configuration
     */
    executeQuery(queryContext, dontRetry) {
        return new Promise((resolve, reject) => {
            try {
                this.connection.query(queryContext.sql, queryContext.values, (err, data) => {
                    if (err && err.code && err.code === '23505') err = new RelatedError.DuplicateKeyError(err);

                    if (err) reject(err);
                    else {
                        if (queryContext.ast) {
                            // AST based query, return plain result
                            resolve(data);
                        } else if (type.object(data)) {
                            switch (data.command) {
                                case 'SELECT':
                                    resolve(data.rows);
                                    break;

                                case 'INSERT':
                                    resolve(data.rows && data.rows.length ? data.rows[0] : null);
                                    break;

                                default:
                                    resolve(data);
                            }
                        } else if (!dontRetry && type.null(data)) {

                            // try again, this may happen under high load
                            // and seems to be a bug of the pg driver used
                            this.executeQuery(queryContext, true).then(resolve).catch(reject);
                        } else {
                            log(queryContext, data);
                            console.log(queryContext, data);
                            reject(new Error('unexpected return value from pg driver!'));
                        }
                    }
                });
            } catch (err) {
                reject(err);
            }
        });
    }





    /**
     * starts a transaction, set isolation mode
     */
    createTransaction() {
        if (this.ended || this.killed) return Promise.reject(new Error('Cannot start transaction, the connection has ended!'));

        // tell everone that we're a transactio noe
        this.isTransaction = true;

        // the transaction is open from now on
        this.transactionOpen = true;

        // conenction should not be returned to the pool
        this.removeFromPool();

        // execute query
        return this.query(new QueryContext({sql: 'start transaction;', mode: 'transaction'}));
    }





    /*
    * build a raw sql query from a pg context
    *
    * @param <Object> pq query context
    *
    * @returns <String> full SQL query
    */
    renderSQLQuery(sql, values) {
        var   sql       = sql || ''
            , values    = values || []
            , reg       = /\$[0-9]+/gi
            , index     = 0
            , match;

        while (match = reg.exec(sql)) {
            if (values.length > index) {
                sql = sql.replace(match[0], this.escape(values[index]));
            }

            // adjust regexp
            reg.lastIndex += this.escape(values[index]).length-match[0].length;

            index++;
        }

        return sql;
    }
}