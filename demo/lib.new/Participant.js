const EventEmitter	= require('events').EventEmitter;
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


class Participant
{
	constructor(id,name,tm,room)
	{
		//Store props
		this.id = id;
		this.name = name;
		this.tm=tm;
		this.count=0;
		
		//And casting
		this.room = room;
		
		//Create event emitter
		this.emitter = new EventEmitter();
		
		//Streams
		this.incomingStreams = new Map();//这个里面一般就一个stream 对应一个前端的音+视频mlines
		this.outgoingStreams = new Map();
		
		//SDP info
		this.localSDP = null;
		this.remoteSDP = null;
		
		//Create uri
		this.uri = room.uri.concat(["participants",id]);
		
		this.debug = function(str) {
			room.debug("participant["+id+"]::"+str)
		};
	}
	
	getId() 
	{
		return this.id;
	}
	
	init(offer) {
		this.debug("init");
		//Get data
		const endpoint  = this.room.getEndpoint();
		endpoint.on("stopped",()=>this.stop());
		
		//Create an DTLS ICE transport in that enpoint
        /* A transport represent a connection between a local ICE candidate and a remote set of ICE candidates over a single DTLS session.
        * The transport object will internally allocate the ICE and DTLS information of the local side in order to singal it to the remote side and establish the connection.
        * Each transport has a set of incoming and outgoing streams that allow to send or receive RTP streams to the remote peer. 
        * You must create the incoming streams as signaled on the remote SDP as any incoming RTP with an unknown ssrc will be ignored. 
        * When you create an outgoing stream, the transport will allocate internally the ssrcs for the different RTP streams in order to avoid collision. You will be able to retrieve that information from the streams object in order to be able to announce them on the SDP sent to the remote side.
        * In order to decide how to route your streams you must attach the outgoing streams from one transport to the incoming streams of other (or same) transport.
        */
		this.transport = endpoint.createTransport(offer);	
		//Dump contents
		//this.transport.dump("/tmp/sfu-"+this.uri.join("-")+".pcap");

		//Set RTP remote properties
		//通过前端的sdp,来生成对应的audio和video信息
		this.transport.setRemoteProperties(offer);

		//Create local SDP info
		const answer = offer.answer({
			dtls		: this.transport.getLocalDTLSInfo(),
			ice		: this.transport.getLocalICEInfo(),
			candidates	: endpoint.getLocalCandidates(),
			capabilities	: this.room.getCapabilities()
		});
		
		//Set RTP local  properties
		this.transport.setLocalProperties(answer);
		
		//All good
		//此处关键，生成的localSDP
		//this.localSDP = answer;//估计用不上了
		//this.remoteSDP = sdp;//估计用不上了


		//********************************* */
		const id=this.count++;
		const pcns =this.tm.namespace("medooze::pc::"+id);

		var that=this;
		//listen local events and send to remote client
		//由createOutgoingtrack来触发
		//createincomingtrack之后,才调用createOutgoingtrack
		this.transport.on("outgoingtrack",(track,stream)=>{
			//send new event 要发到客户端，客户端对应做出响应
			pcns.event("addedtrack",{
				streamId:stream?stream.getId():"-",
				track: track.getTrackInfo()
			});
			track.once("stopped",()=>{
				//send ended event
				pcns.event("removedtrack",{
					streamId:stream?stream.getId():"-",
					trackId:track.getId()
				});
			});
			}).on("outgoingstream",(stream)=>{
				//for each stream
				for(const track of stream.getTracks()){
					//send new event
					pcns.event("addedtrack",{
						streamId:stream?stream.getId():"-",
						track: track.getTrackInfo()
					});
					//listen for close track
					track.once("stopped",()=>{
						//send ended event
						pcns.event("removedtrack",{
							streamId:stream?stream.getId():"-",
							trackId:track.getId()
						});
					});
				}
			}).on("stopped",()=>{
				//send event
				pcns.event("stopped");
				//close ns
				pcns.close();
			});

			//listen remote events from client
			pcns.on("event",(event)=>{
				//get event data
				const data =event.data;
				//depending on the event
				switch(event.name){
					case "addedtrack":{
						//Get events
						const streamId=data.streamId;
						const trackInfo=TrackInfo.expand(data.track);	
						//Get stream
						let incomingStream=that.transport.getIncomingStream(streamId);	
						//if we already have it
						if(!incomingStream){
							//create empty one
							incomingStream=that.transport.createIncomingStream(new StreamInfo(streamId));
							//added to the list
							this.incomingStreams.set(incomingStream.id,incomingStream);//此处替代了publishStream
							//publish stream to room
							this.emitter.emit("stream",incomingStream);

						}
						//create incoming track
						const track=incomingStream.createTrack(trackInfo);
						break;
					}
					case "removedtrack":
					{
						//Get events
						const streamId=data.streamId;
						const trackId=data.trackId;
						//Get stream
						let stream=that.transport.getIncomingStream(streamId);
						//if we alread have it
						if(!stream){
							return;
						}
						//get track
						const track=stream.getTrack(trackId);
						//if no track
						if(!track){
							return;
						}
						//stop track
						track.stop();
						//id stream has no more tracks
						if(!stream.getTracks().length){
							stream.stop();
						}
						break;
					}
					case "stop":
					that.transport.stop();
				}
			});

			//listen for incoming tracks
			this.transport.on("incomingtrack",(track,stream)=>{
				//此处不调addStream原因是因为自己不可能把自己的再发回去
				//貌似不需要处理了

			});
			
			return {
                                id:id,
                                dtls:answer.getDTLS().plain(),
                                ice: answer.getICE().plain(),
                                candidates: endpoint.getLocalCandidates(),
                                capabilities:this.capabilities

                        }	

	}
		
	publishStream(streamInfo)
	{
		this.debug("publishStream()");
		
		//If already publishing
		if (!this.transport)
			throw Error("Not inited");

		//Create the remote participant stream into the transport
		const incomingStream = this.transport.createIncomingStream(streamInfo);
		
		//Add origin
		incomingStream.uri = this.uri.concat(["incomingStreams",incomingStream.getId()]);

		//Append
		this.incomingStreams.set(incomingStream.id,incomingStream);

		//Publish stream
		this.debug("onstream");
		//在Room.js 89行响应 for循环 other.addStream(stream)
		this.emitter.emit("stream",incomingStream);
	}
	
	//根据join的人的stream,生成对应的outgoingStream
	//join进来的其他人都会调你的这个,自己不会调自己的
	addStream(stream) {		
		//get stream id from remote id
		const outgoingStreamId="remote-"+stream.getId();
		//Get stream
		let outgoingStream=transport.getOutgoingStream(outgoingStreamId);
		//if not found
		if(!outgoingStream){
			//create it
			outgoingStream=transport.createOutgoingStream(outgoingStreamId);
			//add to the list
			that.outgoingStreams.set(outgoingStream.id,outgoingStream);
		}
		outgoingStream.attachTo(stream);

	}
	
		
	getInfo() {
		//Create info 
		const info = {
			id	: this.id,
			name	: this.name,
			streams : [
				this.incomingStream ? this.incomingStream.getId() : undefined
			]
		};
		
		//Return it
		return info;
	}
	
	getLocalSDP() {
		return this.localSDP;
	}
	
	getRemoteSDO() {
		return this.remoteSDP;
	}
	
	getIncomingStreams() {
		return this.incomingStreams.values();
	}
	
	/**
	 * Add event listener
	 * @param {String} event	- Event name 
	 * @param {function} listeener	- Event listener
	 * @returns {Transport} 
	 */
	on() 
	{
		//Delegate event listeners to event emitter
		this.emitter.on.apply(this.emitter, arguments);  
		//Return object so it can be chained
		return this;
	}
	
	/**
	 * Remove event listener
	 * @param {String} event	- Event name 
	 * @param {function} listener	- Event listener
	 * @returns {Transport} 
	 */
	off() 
	{
		//Delegate event listeners to event emitter
		this.emitter.removeListener.apply(this.emitter, arguments);
		//Return object so it can be chained
		return this;
	}
	
	stop() 
	{
		this.debug("stop");
		
		//remove all published streams
		for (let stream of this.incomingStreams.values())
			//Stop it
			stream.stop();
		

		//Remove all emitting streams
		for (let stream of this.outgoingStreams.values())
			//Stop it
			stream.stop();
			
		//IF we hve a transport
		if (this.transport)
			//Stop transport
			this.transport.stop();
		
		//Clean them
		this.room = null;
		this.incomingStreams = null;
		this.outgoingStreams = null;
		this.transport = null;
		this.localSDP = null;
		this.remoteSDP = null;
	
		//Done
		this.debug("onstopped");
		this.emitter.emit("stopped");
	}
};

module.exports = Participant;
