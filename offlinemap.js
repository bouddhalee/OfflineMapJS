var maxNbCachedZoomLevels = 5;
var cacheLoadedImages = false;
var nbImagesLeftToSave = 0;
var nbImagesWithError = 0;
var hasBeenCanceled = false;

// TAKEN FROM OfflineMap
var ajax = function (src, responseType, callback, error, queueCallback) {
    if(hasBeenCanceled){
        queueCallback();
        return;
    }

    var xhr = new XMLHttpRequest();
    xhr.open('GET', src, true);
    xhr.responseType = responseType || 'text';
    xhr.onload = function(err) {
        if (this.status == 200) {
            callback(this.response);
        }
        else{
            error();
        }
        queueCallback();
    };
    xhr.send();
};

OfflineLayer = L.TileLayer.extend({

    initialize: function (url, options) {
        this._onReady = options["onReady"];
        L.TileLayer.prototype.initialize.call(this, url, options);

        var self = this;

        this._images = new IDBStore({
            dbVersion: 1,
            storeName: 'OfflineLeafletImages',
            keyPath: null,
            autoIncrement: false
        }, this._onReady);
        console.log("allo");
    },

    // TAKEN FROM OfflineMap
    _imageToDataUri: function (image) {
        var canvas = window.document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;

        var context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);

        return canvas.toDataURL('image/png');
    },

    // TAKEN FROM OfflineMap
    _tileOnLoadWithCache: function () {
        this._images.put(this._storageKey, {"image": this._layer._imageToDataUri(this)});
        L.TileLayer.prototype._tileOnLoad.apply(this, arguments);
    },

    // TAKEN FROM OfflineMap
    _setUpTile: function (tile, key, value, cache) {
        if (cache) {
            tile._storageKey = key;
            tile.onload = this._tileOnLoadWithCache;
            tile.crossOrigin = 'Anonymous';
        } else {
            tile.onload = this._tileOnLoad;
        }
        tile.src = value;
        this.fire('tileloadstart', {
            tile: tile,
            url: tile.src
        });
    },

    _loadTile: function (tile, tilePoint) {
        tile._layer = this;
        tile.onerror = this._tileOnError;
        this._adjustTilePoint(tilePoint);

        var self = this;
        var onSuccess = function(item){
            if(item){
                console.log("found");
                self._setUpTile(tile, key, item.image, false);
            }
            else{
                console.log("not found");
                self._setUpTile(tile, key, self.getTileUrl(tilePoint), cacheLoadedImages);
            }
        }

        var onError = function() {
            console.log("error");
            this._setUpTile(tile, key, this.getTileUrl(tilePoint), cacheLoadedImages);
        }

        var key = tilePoint.x + ", " + tilePoint.y + ", " + tilePoint.z;
        this._images.get(key, onSuccess, onError);
    },

    saveImages: function(){
        var startingZoom = this._getZoomForUrl();
        var maxZoom = this._map.getMaxZoom();
        var minZoom = 2;
        console.log("actualZoom: " + startingZoom);

        var nbZoomLevelsToCache = maxZoom - startingZoom;
        if(nbZoomLevelsToCache > maxNbCachedZoomLevels){
            alert("Not possible to save more than " + maxNbCachedZoomLevels + " zoom levels.")
        }

        if(this._myQueue){
            alert("system is busy.")
            return;
        }

        this._imagesToQuery = {};

        for(var tile in this._tiles){
            var split = tile.split(":");
            var x = parseInt(split[0]);
            var y = parseInt(split[1]);
            this.getZoomedInImages(x, y, startingZoom, maxZoom);
            this.getZoomedOutImages(Math.floor(x/2), Math.floor(y/2), startingZoom - 1, minZoom);
        }

        var imagesToQueryArray = [];
        for(var key in this._imagesToQuery){
            imagesToQueryArray.push(key);
        }

        var self = this;
        this._images.getBatch(imagesToQueryArray, function(items){
                self._myQueue = queue(8);
                var i = 0;
                items.forEach(function (item){
                    if(item){
                        // image already exist
                    }
                    else{
                        var key = imagesToQueryArray[i];
                        var data = self._imagesToQuery[key];

                        nbImagesLeftToSave++;
                        //controls._counter.innerHTML = nbImagesLeftToSave;

                        console.log("will defer for key " + key);
                        self._myQueue.defer(ajax, self.createURL(data.x, data.y, data.z), 'arraybuffer', function (response) {
                                self._images.put(key, {"image": arrayBufferToBase64ImagePNG(response)});
                                console.log("added image with key: " + key);
                                nbImagesLeftToSave--;
                                //controls._counter.innerHTML = nbImagesLeftToSave;
                            },
                            function (){
                                nbImagesWithError++;
                                //controls._errorCounter.innerHTML = nbImagesWithError;
                                nbImagesLeftToSave--;
                                //controls._counter.innerHTML = nbImagesLeftToSave;
                            });
                    }

                    i++;
                });

                console.log("will wait for all");
                self._myQueue.awaitAll(function(error, data) {
                    self._myQueue = null;
                    console.log("done waiting");
                    nbImagesLeftToSave = 0;
                    //controls._counter.innerHTML = nbImagesLeftToSave;
                });
            }, this.onImageError, 'dense');
    },

    getZoomedInImages: function(x, y, currentZ, maxZ){
        this.getImage(x, y, currentZ);

        if(currentZ < maxZ){
            this.getZoomedInImages(x * 2, y * 2, currentZ + 1, maxZ);
            this.getZoomedInImages(x * 2 + 1, y * 2, currentZ + 1, maxZ);
            this.getZoomedInImages(x * 2, y * 2 + 1, currentZ + 1, maxZ);
            this.getZoomedInImages(x * 2 + 1, y * 2 + 1, currentZ + 1, maxZ);
        }
    },

    getZoomedOutImages: function(x, y, currentZ, finalZ){
        this.getImage(x, y, currentZ);
        if(currentZ > finalZ){
            //console.log("zoomed out image: " + x + ", " + y + ", " + currentZ)
            this.getZoomedOutImages(Math.floor(x / 2), Math.floor(y / 2), currentZ - 1, finalZ);
        }
    },

    getImage: function(x, y, z){
        var key = createKey(x, y, z);
        if(!this._imagesToQuery[key]){
            this._imagesToQuery[key] = {key:key, x: x, y: y, z: z};
        }
    },

    onImageError: function(){
        // What should be done?
        console.log("Image error");
    },

    createURL: function(x, y, z){
        var subdomainIndex = Math.abs(x + y) % this.options.subdomains.length;
        var subdomain = this.options.subdomains[subdomainIndex];
        return L.Util.template(mapquestUrl,
            L.extend({
                s: subdomain,
                z: z,
                x: x,
                y: y
            }, this.options));
    }
});

// TAKEN FROM OfflineMap
/*
 Probably btoa can work incorrect, you can override btoa with next example:
 https://developer.mozilla.org/en-US/docs/Web/JavaScript/Base64_encoding_and_decoding#Solution_.232_.E2.80.93_rewriting_atob%28%29_and_btoa%28%29_using_TypedArrays_and_UTF-8
 */
function arrayBufferToBase64ImagePNG(buffer) {
    var binary = '';
    var bytes = new Uint8Array(buffer);
    for (var i = 0, l = bytes.byteLength; i < l; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return 'data:image/png;base64,' + btoa(binary);
}

function createKey(x, y, z){
    return x + ", " + y + ", " + z;
}

var MyControl = L.Control.extend({
    options: {
        position: 'topright'
    },

    onAdd: function (map) {
        var controls = L.DomUtil.create('div', 'leaflet-buttons-control-button', this._container);

        var cacheButton = L.DomUtil.create('img', 'cache-button', controls);
        cacheButton.setAttribute('src', "cacheBtn.png");

        this._counter = L.DomUtil.create('div', 'counter', controls);
        this._counter.innerHTML = "0";

        this._errorCounter = L.DomUtil.create('div', 'error-counter', controls);
        this._errorCounter.innerHTML = "0";

        var cancelButton = L.DomUtil.create('img', 'cancel-button', controls);
        cancelButton.setAttribute('src', "cancelBtn.png");

        L.DomEvent.addListener(cacheButton, 'click', this.onCacheClick, this);
        L.DomEvent.disableClickPropagation(cacheButton);

        L.DomEvent.addListener(cancelButton, 'click', this.onCancelClick, this);
        L.DomEvent.disableClickPropagation(cancelButton);

        return controls;
    },

    onCacheClick: function (){
        hasBeenCanceled = false;
        this._offlineLayer.saveImages();
    },

    onCancelClick: function (){
        hasBeenCanceled = true;
    },

    setOfflineLayer: function (offlineLayer){
        this._offlineLayer = offlineLayer;
    }
});