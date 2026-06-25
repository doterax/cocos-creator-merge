cmake_minimum_required(VERSION 2.6)
project (FireMerge)

include_directories("./src")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_executable(FireMerge src/merge.cpp)

install(TARGETS FireMerge DESTINATION bin)
