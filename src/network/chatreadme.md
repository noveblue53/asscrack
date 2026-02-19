// On one terminal, start the receiver with

node src/network/receiver.mjs

// You will see something like 
Receiver started with id: 12D3KooWP7p1YhKxxu96U9tm2kfvxe9T2gNdTzR3tNDuic8FWM5E
/ip4/127.0.0.1/tcp/62139/p2p/12D3KooWP7p1YhKxxu96U9tm2kfvxe9T2gNdTzR3tNDuic8FWM5E
Listening on addresses: undefined <= IGNORE THIS I NEED TO FIX IT

// Copy the full address that appears above the line I told you to ignore.
// Open a second terminal and start the transmitter with

node src/network/transmitter.mjs (the address you copied earlier)

// You should be able to type a message into the transmitter terminaL and see it appear
// on the receiver terminal.
// Next step: two way comms