#!/bin/bash

echo "Waiting for database to be ready..."

MAX_TRIES=30
TRIES=0
while [ $TRIES -lt $MAX_TRIES ]; do
    if node -e "
        const mysql = require('mysql2/promise');
        mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            port: process.env.DB_PORT || 3321,
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '123qweasd',
            database: process.env.DB_NAME || 'youtarr'
        }).then(() => {
            console.log('Database connection successful');
            process.exit(0);
        }).catch((err) => {
            process.exit(1);
        });
    " 2>/dev/null; then
        echo "Database is ready!"
        break
    fi

    TRIES=$((TRIES + 1))
    if [ $TRIES -eq $MAX_TRIES ]; then
        echo "Failed to connect to database after $MAX_TRIES attempts"
        exit 1
    fi

    echo "Waiting for database... (attempt $TRIES/$MAX_TRIES)"
    sleep 2
done

echo "Starting application with arguments: $@"

# If no command was passed by docker-compose, fall back to production mode
if [ $# -eq 0 ]; then
    exec node /app/server/server.js
else
    # Automatically swaps process ID 1 over to the docker-compose command (like node --watch)
    exec "$@"
fi