:9000 {
    reverse_proxy master:9000 slave:9000 {
        health_uri /ha/ready
        health_status 200
        health_interval 2s
        health_timeout 1s
        lb_policy first
        lb_try_duration 3s
        header_up Host {http.request.host}
        header_up -X-27G-Client-IP
        transport http {
            keepalive 2s
        }
    }
}
