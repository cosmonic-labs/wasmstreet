# pricer-monte-carlo — C++ -> WASI 0.2 reactor component

WASI_SDK_PATH ?= $(HOME)/wasi-sdk/wasi-sdk-28.0-arm64-macos
CXX_WASM := $(WASI_SDK_PATH)/bin/wasm32-wasip2-clang++

WIT_BINDGEN := wit-bindgen

BINDINGS_DIR := bindings
WIT_DIR      := wit

TARGET := pricer-monte-carlo.wasm

BINDING_CPP := $(BINDINGS_DIR)/mc_pricer.cpp
BINDING_OBJ := $(BINDINGS_DIR)/mc_pricer_component_type.o
BINDING_HDR := $(BINDINGS_DIR)/mc_pricer_cpp.h

CXXFLAGS_WASM := \
	-I $(BINDINGS_DIR) -I . -I src \
	-Wall -Wextra -Werror -Wno-unused-parameter \
	-std=c++23 \
	-fno-exceptions \
	-mexec-model=reactor \
	-O2

CXX_NATIVE := clang++
CXXFLAGS_NATIVE := -std=c++23 -O2 -Wall -Wextra -Werror -Wno-unused-parameter

.PHONY: all wasm
all: wasm
wasm: $(TARGET)

$(TARGET): src/component.cpp src/monte_carlo.h $(BINDING_CPP) $(BINDING_OBJ)
	$(CXX_WASM) \
		src/component.cpp \
		$(BINDING_CPP) \
		$(BINDING_OBJ) \
		$(CXXFLAGS_WASM) \
		-o $(TARGET)

.PHONY: bindgen
bindgen: $(BINDING_CPP)

$(BINDING_CPP) $(BINDING_OBJ) $(BINDING_HDR): $(WIT_DIR)/world.wit
	@mkdir -p $(BINDINGS_DIR)
	$(WIT_BINDGEN) cpp --world mc-pricer --out-dir $(BINDINGS_DIR) $(WIT_DIR)

.PHONY: test
test: tests/run-mc-tests
	@./tests/run-mc-tests

tests/run-mc-tests: tests/monte_carlo_test.cpp src/monte_carlo.h
	$(CXX_NATIVE) $(CXXFLAGS_NATIVE) tests/monte_carlo_test.cpp -o tests/run-mc-tests

.PHONY: clean
clean:
	rm -rf $(BINDINGS_DIR) $(TARGET) tests/run-mc-tests
