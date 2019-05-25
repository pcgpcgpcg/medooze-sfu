const TransactionManager = require("transaction-manager");
//Get the Medooze Media Server interface
const MediaServer = require("medooze-media-server");

const Room		 = require("./Room");

//Get Semantic SDP objects
const SemanticSDP	= require("semantic-sdp");
const SDPInfo		= SemanticSDP.SDPInfo;
const MediaInfo		= SemanticSDP.MediaInfo;
const CandidateInfo	= SemanticSDP.CandidateInfo;
const DTLSInfo		= SemanticSDP.DTLSInfo;
const ICEInfo		= SemanticSDP.ICEInfo;
const StreamInfo	= SemanticSDP.StreamInfo;
const TrackInfo		= SemanticSDP.TrackInfo;
const Direction		= SemanticSDP.Direction;
const CodecInfo		= SemanticSDP.CodecInfo;


const Capabilities = {
	audio : {
		codecs		: ["opus"],
	},
	video : {
		codecs		: ["vp8","h264"],
		rtx		: true,
		rtcpfbs		: [
			{ "id": "goog-remb"},
			{ "id": "transport-cc"},
			{ "id": "ccm", "params": ["fir"]},
			{ "id": "nack"},
			{ "id": "nack", "params": ["pli"]}
			
		],
		extensions	: [
			"urn:3gpp:video-orientation",
			"http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
			"http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
			"urn:ietf:params:rtp-hdrext:toffse",
			"urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id",
			"urn:ietf:params:rtp-hdrext:sdes:mid",
		],
		simulcast	: true
	}
};

const rooms=new Map();

//room:room name as string
module.exports = function(request,protocol,ip, wsServer)
{
    const connection = request.accept(protocol);
    	//parse Url
    const url=request.resourceURL;
    let participant;
    let room=rooms.get(url.query.id);
    //if not found
    if(!room){
        room = new Room(url.query.id,ip);
        //Append to room list
        rooms.set(room.getId(),room);
    }
    //Create new transaction manager
    const tm = new TransactionManager(connection);
    tm.on("cmd",async function(cmd){
        //Get command data
        const data = cmd.data;
        //check command type
        switch(cmd.name){
            case "join":
            try{
                if(participant){
                    return cmd.reject("Already joined");
                }
                //Create it
                participant=room.createParticipant(data.name,tm);
                //check
                if(!participant){
                    return cmd.reject("Error Creating participant");
                }
                //add listener
                room.on("participants",(participants)=>{
                    tm.event("participants:",participants);
                });
                //process the sdp
                const sdp=SDPInfo.expand(data.sdp);
                //get all streams before adding us
                const streams=room.getStreams();
                //init participant
		let res = participant.init(sdp);
		cmd.accept(res);
                //for each one 把当前屋子里有的流加入，会连续触发对应客户端的ontrack


                for(let stream of streams){
                    //Add it
                    participant.addStream(stream);
                }
                //listen for participant events
                participant.on("stopped",function(){
                    //connection.close();
                    room.off("participants",(participant)=>{
                        tm.event("participants:",participants);
                    })

                });

		connection.on("close",function(){
			console.log("##################" + participant.id);
			participant.stop();
		});

            }catch(error){
                console.error(error);
            }
            break;
        }
    })	
	//Create new managed peerconnection server for this
	//const mngr = endpoint.createPeerConnectionServer(tm,Capabilities);
}
