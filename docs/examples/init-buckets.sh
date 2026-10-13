#!/bin/sh
set -eu

27g create-bucket "my-bucket" --if-not-exists
27g create-bucket "my-bucket-2" --if-not-exists
27g create-bucket "my-bucket-3" --if-not-exists
