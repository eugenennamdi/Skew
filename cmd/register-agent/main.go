package main

import (
	"context"
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"os"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

const (
	RegistryAddress = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
	CeloRPC         = "https://forno.celo.org"
	ChainID         = 42220
	AttributionTag  = "celo_7935fb97e273"
)

var ERCMarker = [16]byte{
	0x80, 0x21, 0x80, 0x21, 0x80, 0x21, 0x80, 0x21,
	0x80, 0x21, 0x80, 0x21, 0x80, 0x21, 0x80, 0x21,
}

func appendAttribution(calldata []byte) []byte {
	tagBytes := []byte(AttributionTag)
	suffix := make([]byte, 0, len(tagBytes)+2+len(ERCMarker))
	suffix = append(suffix, tagBytes...)
	suffix = append(suffix, byte(len(tagBytes)))
	suffix = append(suffix, 0x00) // Schema 0
	suffix = append(suffix, ERCMarker[:]...)

	tagged := make([]byte, len(calldata)+len(suffix))
	copy(tagged, calldata)
	copy(tagged[len(calldata):], suffix)
	return tagged
}

type AgentMetadata struct {
	Name           string `json:"name"`
	Description    string `json:"description"`
	AttributionTag string `json:"attribution_tag"`
	Corridor       string `json:"corridor"`
	Protocol       string `json:"protocol"`
}

func main() {
	privateKeyHex := os.Getenv("AGENT_PRIVATE_KEY")
	if privateKeyHex == "" {
		privateKeyHex = os.Getenv("STITCH_PRIVATE_KEY")
	}
	if privateKeyHex == "" {
		log.Fatal("AGENT_PRIVATE_KEY or STITCH_PRIVATE_KEY environment variable is required")
	}
	if len(privateKeyHex) > 2 && privateKeyHex[:2] == "0x" {
		privateKeyHex = privateKeyHex[2:]
	}

	client, err := ethclient.Dial(CeloRPC)
	if err != nil {
		log.Fatalf("failed to connect to Celo RPC: %v", err)
	}

	privateKey, err := crypto.HexToECDSA(privateKeyHex)
	if err != nil {
		log.Fatalf("invalid private key: %v", err)
	}

	publicKey := privateKey.Public().(*ecdsa.PublicKey)
	walletAddress := crypto.PubkeyToAddress(*publicKey)
	fmt.Printf("Registering Agent Wallet: %s\n", walletAddress.Hex())

	meta := AgentMetadata{
		Name:           "Skew Market Maker",
		Description:    "Adaptive Inventory-Skew Pricing Agent on Textile FX",
		AttributionTag: AttributionTag,
		Corridor:       "cNGN/USDT",
		Protocol:       "Textile FX (UniswapX Reactor)",
	}
	metaBytes, _ := json.Marshal(meta)
	dataURI := fmt.Sprintf("data:application/json;base64,%s", base64.StdEncoding.EncodeToString(metaBytes))

	selector := crypto.Keccak256([]byte("register(string)"))[:4]
	uriBytes := []byte(dataURI)
	offset := common.LeftPadBytes(big.NewInt(32).Bytes(), 32)
	strLen := common.LeftPadBytes(big.NewInt(int64(len(uriBytes))).Bytes(), 32)
	padLen := (32 - (len(uriBytes) % 32)) % 32
	paddedURI := append(uriBytes, make([]byte, padLen)...)

	var calldata []byte
	calldata = append(calldata, selector...)
	calldata = append(calldata, offset...)
	calldata = append(calldata, strLen...)
	calldata = append(calldata, paddedURI...)

	taggedCalldata := appendAttribution(calldata)

	nonce, err := client.PendingNonceAt(context.Background(), walletAddress)
	if err != nil {
		log.Fatalf("failed to fetch nonce: %v", err)
	}

	tipCap, _ := client.SuggestGasTipCap(context.Background())
	feeCap, _ := client.SuggestGasPrice(context.Background())

	toAddr := common.HexToAddress(RegistryAddress)
	rawTx := &types.DynamicFeeTx{
		ChainID:   big.NewInt(ChainID),
		Nonce:     nonce,
		GasTipCap: tipCap,
		GasFeeCap: feeCap,
		Gas:       350000,
		To:        &toAddr,
		Value:     big.NewInt(0),
		Data:      taggedCalldata,
	}

	signer := types.NewLondonSigner(big.NewInt(ChainID))
	signedTx, err := types.SignTx(types.NewTx(rawTx), signer, privateKey)
	if err != nil {
		log.Fatalf("failed to sign tx: %v", err)
	}

	err = client.SendTransaction(context.Background(), signedTx)
	if err != nil {
		log.Fatalf("broadcast failed: %v", err)
	}

	txHash := signedTx.Hash().Hex()
	fmt.Printf("\nERC-8004 Registration Broadcast Successful!\nTx Hash:  %s\nCeloScan: https://celoscan.io/tx/%s\n", txHash, txHash)
}
